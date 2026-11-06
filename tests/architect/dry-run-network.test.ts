// Claim check (coordinator, 2026-10-24): "a dry run sends nothing". Passing no --submit proves there is no final submit;
// it does not by itself prove the employer's page saw no upload or autosave. A dry run fills the form (scripts/apply.ts
// fills every planned field to read it back), so the page's own scripts see the values and can send them on their own.
// This runs the real engine (approve-first.ts prepare(), the queue stack's dry run) on a local employer page whose
// scripts do what real application pages do while a person types: autosave by POST, PUT and sendBeacon, upload the chosen
// resume the moment it is picked (Lever's parseResume), autosave by GET with the value in the query string, and load a
// resource from another origin before and after the form is filled. The employer logs every request it receives. What
// the test records is what reached it; nothing beyond this page and these requests is claimed.
import assertNode from "node:assert/strict";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000d1";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-dry-run-test" };
const FACTS = {
  user_id: PERSON,
  answers: {
    first_name: { value: "Dryrun", factId: "DRY-TEST-FACT-1", ...SOURCE },
    last_name: { value: "Tester", factId: "DRY-TEST-FACT-2", ...SOURCE },
    email: { value: "dry.tester@example.test", factId: "DRY-TEST-FACT-3", ...SOURCE },
  },
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

interface Seen { method: string; path: string; query: string; body: number }
function server(page: (base: string, other: string) => string, other = "") {
  const seen: Seen[] = [];
  let base = "";
  const s = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const body = req.body ? (await req.arrayBuffer()).byteLength : 0;
    seen.push({ method: req.method, path: u.pathname, query: u.search, body });
    if (u.pathname === "/apply") return new Response(page(base, other), { headers: { "content-type": "text/html" } });
    if (u.pathname.endsWith(".png")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    return new Response("{}", { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  });
  base = `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}`;
  return { base, seen, close: () => s.shutdown() };
}

// The employer's form, with the scripts a real application page runs while a person fills it.
const form = (_base: string, other: string) => `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST Dryrun Employer</p>
<img src="${other}/before-fill.png" alt="">
<form method="post" action="/apply/submit" enctype="multipart/form-data">
<label for="first">First name</label><input name="first_name" id="first" required>
<label for="last">Last name</label><input name="last_name" id="last" required>
<label for="email">Email</label><input name="email" id="email" type="email" required>
<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>
<button type="submit">Submit application</button></form>
<script>
  // Each write reports what became of it with a same-origin GET (/went or /stopped), so the log shows it was tried.
  const mark = (what, ok) => fetch("/" + (ok ? "went" : "stopped") + "?what=" + what).catch(() => {});
  const tried = (what, p) => p.then(() => mark(what, true), () => mark(what, false));
  let typed = false;
  document.getElementById("first").addEventListener("input", (e) => {
    const v = e.target.value;
    if (typed) return; // once per run is enough to see what happens
    typed = true;
    tried("post-autosave", fetch("/autosave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ first_name: v }) }));
    tried("put-autosave", fetch("/autosave", { method: "PUT", body: v }));
    try { navigator.sendBeacon("/beacon", v); } catch {}
    tried("get-autosave", fetch("/autosave-get?first_name=" + encodeURIComponent(v)));
  });
  let emailed = false;
  document.getElementById("email").addEventListener("input", (e) => {
    if (emailed) return;
    emailed = true;
    tried("other-origin", fetch("${other}/after-fill?email=" + encodeURIComponent(e.target.value)));
    const img = new Image(); img.src = "${other}/after-fill.png?email=" + encodeURIComponent(e.target.value);
  });
  document.getElementById("resume").addEventListener("change", (e) => {
    const fd = new FormData(); fd.append("resume", e.target.files[0]);
    const x = new XMLHttpRequest(); x.open("POST", "/parse-resume");
    x.onload = () => mark("upload", true); x.onerror = () => mark("upload", false);
    x.send(fd);
  });
</script>`;

Deno.test({
  name: "dry run network: what a dry run of the queue stack sends to the employer's page, and what it stops",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserEnv()) {
      if (CI) throw Error("needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const third = server(() => "");
    const employer = server(form, third.base);
    const work = await Deno.makeTempDir({ prefix: "trainee-dryrun-" });
    try {
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify(FACTS));
      await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic dry-run resume\n%%EOF\n"));
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, "--discovery-fill"] });
      // The dry run as prepare() runs it, read directly so the engine's own record of what it stopped can be checked.
      const run = await runEngine(["--url", `${employer.base}/apply`, "--facts", factsPath, "--resume", resumePath]);
      assert(run?.result?.reason === "dry_run", `the dry run reached the card: ${JSON.stringify(run?.result)}`);
      // Let the page's own late requests (beacons, the image) arrive before reading the logs.
      await new Promise((ok) => setTimeout(ok, 500));
      const at = (s: Seen[]) => s.map((x) => `${x.method} ${x.path}${x.query}`);
      console.log(`employer received: ${JSON.stringify(at(employer.seen))}\nother origin received: ${JSON.stringify(at(third.seen))}`);

      // 1. The employer received the page, and nothing else: no write, no request with a body, and (since the
      //    discovery default deny, DISCOVERY-DEFAULT-DENY-2026-10-24.md) not the page's GET autosave either. The test's
      //    own went/stopped marks are requests after the first value too, so they are stopped as well.
      eq(at(employer.seen), ["GET /apply"], "the page, loaded once, is all the employer received");
      // 2. Each write the page tried, and its GET autosave, was tried and stopped by the engine (not merely never made):
      //    the resume upload too, so the engine did put the file on the form.
      const stopped = (run?.evidence?.discovery?.stopped ?? []).map((x: any) => `${x.method} ${x.origin === employer.base ? "" : "other:"}${x.path}`);
      for (const w of ["POST /autosave", "PUT /autosave", "POST /beacon", "GET /autosave-get", "POST /parse-resume", "GET other:/after-fill"]) {
        assert(stopped.includes(w), `stopped: ${w} (${stopped.join(", ")})`);
      }
      // 3. Another origin: the image the page loads before anything is filled is fetched; after it, nothing.
      assert(third.seen.some((x) => x.path === "/before-fill.png"), "a resource from another origin, before the form is filled");
      eq(third.seen.filter((x) => x.path.startsWith("/after-fill")).length, 0, "after the form is filled, nothing reaches another origin");
    } finally {
      await employer.close();
      await third.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
