// The boundary (DISCOVERY-DEFAULT-DENY-2026-10-24.md): before the person's approval nothing of theirs goes into the page.
// Discovery reads the form and plans every answer off the page; the approved run is the first to fill it. The employer's
// own server is the witness, as in dry-run-deny-classes:
//   plain        read-only prepare sends nothing of theirs; the approved run then sends exactly the approved answers, once
//   conditional  a question that appears only once something is filled: the prepare cannot see it, so the approved run
//                finds the form changed and sends nothing (the capability this boundary gives up, given up safely)
//   multi-step   a form that needs a step taken before its last page: not prepared, nothing sent
import assertNode from "node:assert/strict";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const VALUE = "Quorlen";
const FACTS = {
  user_id: "7b0f8f8e-6a43-4a49-9d2c-0000000000d4",
  answers: Object.fromEntries(Object.entries({ first_name: VALUE, last_name: "Tester", email: "quorlen.tester@example.test" }).map(([k, v], i) =>
    [k, { value: v, factId: `RO-TEST-FACT-${i + 1}`, confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-ro" }])),
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

const FIELDS = `<label for="first">First name</label><input name="first_name" id="first" required>
<label for="last">Last name</label><input name="last_name" id="last" required>
<label for="email">Email</label><input name="email" id="email" type="email" required>
<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>`;
const head = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST Boundary Employer</p>`;
// Every page reports what it sees typed, at once, by GET (allowed before any value): the witness of what was put in.
const watch = `<script>for (const e of document.querySelectorAll("input")) e.addEventListener("input", (x) => fetch("/typed?v=" + encodeURIComponent(x.target.value)).catch(() => {}));</script>`;
const PAGES: Record<string, string> = {
  "/plain": `${head}<form method="post" action="/plain/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>${watch}`,
  "/conditional": `${head}<form method="post" action="/conditional/submit" enctype="multipart/form-data">${FIELDS}<div id="more"></div><button type="submit">Submit application</button></form>${watch}
<script>let shown = false; document.getElementById("first").addEventListener("input", () => { if (shown) return; shown = true;
  document.getElementById("more").innerHTML = '<label for="ref">Who referred you?</label><input name="referrer" id="ref" required>'; });</script>`,
  "/multi": `${head}<form method="post" action="/multi/submit" enctype="multipart/form-data">${FIELDS}<button type="button" id="next">Next</button></form>${watch}`,
};

function employer() {
  const log: string[] = [];
  const s = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    let body = "";
    if (req.method === "POST") {
      const form = await req.formData();
      body = [...form.entries()].map(([k, v]) => `${k}=${typeof v === "string" ? v : `file:${v.name}`}`).join("&");
    }
    log.push(`${req.method} ${u.pathname}${u.search}${body ? ` BODY ${body}` : ""}`);
    if (req.method === "POST") {
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: RO-1.</p>`, { headers: { "content-type": "text/html" } });
    }
    const page = PAGES[u.pathname];
    return page ? new Response(page, { headers: { "content-type": "text/html" } }) : Response.json({ ok: true });
  });
  return { base: `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}`, log, close: () => s.shutdown() };
}
const carries = (log: string[]) => log.filter((l) => l.includes(VALUE));

async function run(path: string, approve: boolean) {
  const site = employer();
  const work = await Deno.makeTempDir({ prefix: "trainee-read-only-" });
  try {
    await Deno.writeTextFile(`${work}/facts.json`, JSON.stringify(FACTS));
    await Deno.writeFile(`${work}/resume.pdf`, new TextEncoder().encode("%PDF-1.4\n% synthetic\n%%EOF\n"));
    const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
    const args = ["--url", `${site.base}${path}`, "--facts", `${work}/facts.json`, "--resume", `${work}/resume.pdf`];
    const prepared = await runEngine(args);
    await new Promise((ok) => setTimeout(ok, 1000)); // anything the page would still send after the prepare
    const beforeApproval = [...site.log];
    let approved = null;
    if (approve && prepared?.evidence?.approval_hash) {
      approved = await runEngine([...args, "--submit", "--approved", prepared.evidence.approval_hash]);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    console.log(`${path}: prepared ${JSON.stringify(prepared?.result)} approved ${JSON.stringify(approved?.result)}\n before approval: ${JSON.stringify(beforeApproval)}\n all: ${JSON.stringify(site.log)}`);
    return { prepared, approved, beforeApproval, all: [...site.log] };
  } finally {
    await site.close();
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

const opts = { sanitizeResources: false, sanitizeOps: false };
const guard = () => {
  if (!browserEnv()) { if (CI) throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright browser"); return false; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user"); return false; }
  return true;
};

Deno.test({
  ...opts,
  name: "read-only discovery: the prepare puts nothing of the person's into the page; the approved run sends exactly the approved answers, once",
  async fn() {
    if (!guard()) return;
    const r = await run("/plain", true);
    eq(r.prepared?.result?.reason, "dry_run", JSON.stringify(r.prepared?.result));
    eq(r.prepared?.evidence?.discovery?.read_only, true);
    eq(carries(r.beforeApproval), [], "before the approval the employer received nothing carrying the person's value");
    eq(r.beforeApproval.filter((l) => l.startsWith("GET /typed")), [], "nothing was typed into the page before the approval");
    // The card still shows every answer.
    eq(r.prepared?.evidence?.fields?.map((f: any) => f.name).sort(), ["email", "first_name", "last_name", "resume"]);
    const posts = r.all.filter((l) => l.startsWith("POST "));
    eq(posts.length, 1, `exactly one application: ${JSON.stringify(posts)}`);
    assert(posts[0].includes(`first_name=${VALUE}`) && posts[0].includes("file:resume.pdf"), posts[0]);
    assert(["confirmed", "submitted_unconfirmed"].includes(r.approved?.result?.state), JSON.stringify(r.approved?.result));
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: a question that appears only once something is filled is not seen before approval; the approved run then sends nothing",
  async fn() {
    if (!guard()) return;
    const r = await run("/conditional", true);
    eq(r.prepared?.result?.reason, "dry_run", "the prepare saw the form as it first stands");
    eq(carries(r.beforeApproval), [], "before the approval the employer received nothing carrying the person's value");
    eq(r.all.filter((l) => l.startsWith("POST ")), [], "no application was sent");
    eq(r.approved?.result?.state, "not_submitted", JSON.stringify(r.approved?.result));
    console.log(`conditional: the approved run stopped with ${r.approved?.result?.reason}`);
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: a form with a step before its last page is not prepared before approval",
  async fn() {
    if (!guard()) return;
    const r = await run("/multi", false);
    eq([r.prepared?.result?.state, r.prepared?.result?.reason], ["not_submitted", "MULTI_STEP_NEEDS_APPROVAL"], JSON.stringify(r.prepared?.result));
    eq(carries(r.all), [], "the employer received nothing carrying the person's value");
    eq(r.all.filter((l) => l.startsWith("GET /typed")), [], "nothing was typed into the page");
  },
});
