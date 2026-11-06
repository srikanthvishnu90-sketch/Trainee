// A dry run (scripts/apply.ts without --submit: the queue stack's preparation, and G4's prepareAhead before the person
// asked) must not transmit anything of the person's to an employer, or anyone else, before their approval, while the
// page itself still loads and can be read. Default deny: once the engine has put the first of the person's values into
// the page, nothing leaves the page, of any kind (fetch, XHR, an image, a beacon, a navigation, a popup, a worker, a
// WebSocket message); before that, the page has none of their data (a fresh browser context, service workers blocked),
// and reading it (GET, and an employer's GraphQL read query) is allowed. Nothing here inspects what a request carries:
// a value encoded, shortened or transformed, or a request a timer scheduled before the first fill, is stopped the same.
//
// Fail-first: at the head this branch starts from (f3cfab7f), the employer's log receives the person's values (red).
// Each attempt is also found in the engine's own record of what it stopped (evidence.discovery.stopped), so a green
// cannot come from a script that never ran.
import assertNode from "node:assert/strict";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000d2";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-dry-deny-test" };
const VALUES = { first_name: "Qzrina", last_name: "Tester", email: "qzrina.tester@example.test", location: "Oakvale, IL", school: "TEST Qzr University" };
const FACTS = {
  user_id: PERSON,
  answers: Object.fromEntries(Object.entries(VALUES).map(([k, v], i) => [k, { value: v, factId: `DENY-TEST-FACT-${i + 1}`, ...SOURCE }])),
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

interface Seen { method: string; path: string; query: string; body: string }
function server(page: (base: string) => string) {
  const seen: Seen[] = [], ws: string[] = [];
  let base = "";
  const s = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => ws.push(String(e.data));
      seen.push({ method: "WS", path: u.pathname, query: u.search, body: "" });
      return response;
    }
    const body = req.body ? new TextDecoder().decode(await req.arrayBuffer()) : "";
    seen.push({ method: req.method, path: u.pathname, query: u.search, body, at: Date.now() } as any);
    if (u.pathname === "/apply") return new Response(page(base), { headers: { "content-type": "text/html" } });
    if (u.pathname === "/frame") return new Response(FRAME, { headers: { "content-type": "text/html" } });
    if (u.pathname.endsWith(".png")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    if (u.pathname === "/graphql") return Response.json({ data: { form: { fields: 5 } } });
    return Response.json({ ok: true }, { headers: { "access-control-allow-origin": "*" } });
  });
  base = `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}`;
  return { base, seen, ws, close: () => s.shutdown() };
}

// A same-origin frame that reads the parent's field and sends it on.
const FRAME = `<!doctype html><script>
  setInterval(() => { try { const v = parent.document.getElementById("first").value; if (v) fetch("/frame-leak?v=" + encodeURIComponent(v)).catch(() => {}); } catch {} }, 100);
</script>`;

// The employer's form. Each script does what real pages do with what a person types.
// navigate: the email field's script also opens a popup and navigates the page with the email in the URL (its own run, as
// a navigation that is let through reloads the form and ends the run before the later fields are filled).
const form = (other: string, navigate = false) => (base: string) => `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST Deny Employer</p>
<img src="${other}/before-fill.png" alt="">
<form method="post" action="/apply/submit" enctype="multipart/form-data">
<label for="first">First name</label><input name="first_name" id="first" required>
<label for="last">Last name</label><input name="last_name" id="last" required>
<label for="email">Email</label><input name="email" id="email" type="email" required>
<label for="loc">Location</label><input name="location" id="loc" required>
<label for="school">School</label><input name="school" id="school" required>
<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>
<button type="submit">Submit application</button></form>
<iframe src="/frame" style="display:none"></iframe>
<script>
  const q = (p) => p.catch(() => {});
  // Read-only discovery, before any value: the form's definition and a GraphQL read query (Ashby builds its form so).
  q(fetch("/form.json"));
  q(fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query Form { form { fields } }" }) }));
  // Scheduled before any value: a timer that sends the field when it has one, and a socket opened now.
  setInterval(() => { const v = document.getElementById("first").value; if (v) q(fetch("/poll?v=" + encodeURIComponent(v))); }, 50);
  const ws = new WebSocket("${base.replace("http", "ws")}/ws");
  const once = (id, f) => { let done = false; document.getElementById(id).addEventListener("input", (e) => { if (!done) { done = true; f(e.target.value); } }); };
  once("first", (v) => {
    q(fetch("/autosave-get?first_name=" + encodeURIComponent(v)));
    q(fetch("/t?s=" + v.slice(0, 2) + "&r=" + v.split("").reverse().join("") + "&b=" + btoa(v)));
    new Image().src = "/pixel.png?n=" + encodeURIComponent(v);
    q(fetch("/autosave", { method: "POST", body: JSON.stringify({ v }) }));
    q(fetch("/autosave", { method: "PUT", body: v }));
    try { navigator.sendBeacon("/beacon", v); } catch {}
    try { ws.readyState === 1 ? ws.send("first:" + v) : ws.addEventListener("open", () => ws.send("first:" + v)); } catch {}
    try {
      const w = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => fetch(e.data).catch(() => {})"], { type: "text/javascript" })));
      w.postMessage("${base}/worker?v=" + encodeURIComponent(v));
    } catch {}
    q(fetch("${other}/after-fill?v=" + encodeURIComponent(v)));
  });
  once("loc", (v) => q(fetch("/places?q=" + encodeURIComponent(v))));
  once("school", (v) => q(fetch("/schools?q=" + encodeURIComponent(v))));
  ${navigate ? `once("email", (v) => {
    try { window.open("${other}/popup?e=" + encodeURIComponent(v)); } catch {}
    setTimeout(() => { location.href = "/apply?e=" + encodeURIComponent(v); }, 200);
  });` : ""}
</script>`;

const leaks = (s: { seen: Seen[]; ws: string[] }) => {
  const words = Object.values(VALUES).flatMap((v) => [v, encodeURIComponent(v), btoa(v), v.slice(0, 2) === "Qz" ? "" : v.slice(0, 2), v.split("").reverse().join("")])
    .filter(Boolean);
  const said = (x: string) => words.some((w) => x.includes(w)) || /[?&]s=Qz/.test(x);
  return [...s.seen.filter((x) => said(decodeURIComponent(x.query) + " " + x.query + " " + x.body + " " + x.path)).map((x) => `${x.method} ${x.path}${x.query}`),
    ...s.ws.filter(said).map((m) => `WS ${m}`)];
};

async function dryRun(navigate: boolean, check: (o: { run: any; employer: ReturnType<typeof server>; other: ReturnType<typeof server> }) => void) {
    if (!browserEnv()) {
      if (CI) throw Error("needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const other = server(() => "");
    const employer = server(form(other.base, navigate));
    const work = await Deno.makeTempDir({ prefix: "trainee-dryrun-deny-" });
    try {
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify(FACTS));
      await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic dry-run resume\n%%EOF\n"));
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, "--discovery-fill"] });
      const started = Date.now();
      const run = await runEngine(["--url", `${employer.base}/apply`, "--facts", factsPath, "--resume", resumePath]);
      const exited = Date.now();
      console.log(`PROBE run ${exited - started}ms`);
      for (const x of employer.seen as any[]) if (/poll|apply/.test(x.path)) console.log(`PROBE ${x.method} ${x.path}${x.query} ${x.at - exited}ms vs exit`);
      await new Promise((ok) => setTimeout(ok, 800)); // late timers, the socket, the popup
      const at = (s: Seen[]) => s.map((x) => `${x.method} ${x.path}${x.query}`);
      console.log(`result: ${JSON.stringify(run?.result)}\nemployer received: ${JSON.stringify(at(employer.seen))}\nother origin received: ${JSON.stringify(at(other.seen))}\nsocket messages: ${JSON.stringify(employer.ws)}\nstopped: ${JSON.stringify(run?.evidence?.discovery?.stopped ?? null)}`);

      check({ run, employer, other });
    } finally {
      await employer.close();
      await other.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
}

const opts = { sanitizeResources: false, sanitizeOps: false };
Deno.test({
  ...opts,
  name: "dry run, default deny: nothing of the person's leaves the page before their approval, by any channel; reading the page still works",
  fn: () => dryRun(false, ({ run, employer, other }) => {
      // 1. Nothing of the person's reached the employer or anyone else: no value in any form, by any channel.
    eq(leaks(employer), [], "the employer received none of the person's values");
    eq(leaks(other), [], "another origin received none of the person's values");
    eq(employer.ws, [], "no WebSocket message left the page");
    eq(employer.seen.filter((x) => !["GET", "HEAD", "WS"].includes(x.method) && x.path !== "/graphql").map((x) => `${x.method} ${x.path}`), [],
      "no write of any kind");
    // 2. Each attempt was made and stopped by the engine (not merely never made).
    const stopped = new Set<string>((run?.evidence?.discovery?.stopped ?? []).map((x: any) => `${x.origin === employer.base ? "" : "other:"}${x.path}`));
    for (const p of ["/autosave-get", "/t", "/pixel.png", "/autosave", "/beacon", "/places", "/schools", "/poll", "/frame-leak", "/worker", "other:/after-fill"]) {
      assert(stopped.has(p), `the engine stopped ${p} (stopped: ${[...stopped].join(", ")})`);
    }
    // 3. Reading the page still works: the page, its form definition and a read query, before any value; the dry run
    //    reaches the card.
    for (const p of ["/apply", "/form.json", "/graphql", "/frame"]) assert(employer.seen.some((x) => x.path === p && !x.query), `read: ${p}`);
    assert(other.seen.some((x) => x.path === "/before-fill.png"), "a resource from another origin before any value");
    eq(run?.result?.reason, "dry_run", `the dry run reaches the card: ${JSON.stringify(run?.result)}`);
    for (const [k, v] of Object.entries(VALUES)) {
      assert(run?.evidence?.fields?.some((f: any) => f.name === k && f.value === v), `${k} is filled and read back`);
    }
  }),
});
Deno.test({
  ...opts,
  name: "dry run, default deny: a navigation or a popup carrying the person's email is stopped; the run ends, named, with nothing sent",
  fn: () => dryRun(true, ({ run, employer, other }) => {
    eq(leaks(employer), [], "the employer received none of the person's values");
    eq(leaks(other), [], "another origin received none of the person's values");
    assert(!employer.seen.some((x) => x.path === "/apply" && x.query), "the page was not reloaded with the email in its URL");
    assert((run?.evidence?.discovery?.stopped ?? []).some((x: any) => x.kind === "navigation" && x.path === "/apply"), "the navigation was tried and stopped");
    // Following it would send the email, and the page is gone once it is stopped: this posting is not prepared before
    // the person's approval (it is not a card), and the reason says why.
    eq([run?.result?.state, run?.result?.reason], ["not_submitted", "DISCOVERY_NAVIGATION_STOPPED"], JSON.stringify(run?.result));
  }),
});
