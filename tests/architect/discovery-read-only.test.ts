// The boundary (DISCOVERY-DEFAULT-DENY-2026-10-24.md): before the person's approval none of their answers is typed
// into the page or sent. Discovery reads the form and plans every answer off the page; the approved run is the first to
// fill it. The employer's own server (and another origin's) is the witness; the record and the card are read too:
//   plain        the prepare types nothing; the card says the form is not filled yet; the approved run sends exactly the
//                approved answers, once
//   conditional  a question that appears only once something is filled: not seen before approval; the approved run
//                sends nothing, and the queue's record says the application was incomplete, with the question
//   multi-step   a form with a step before its last page: not prepared
//   lookup       a typed field whose answer is a hidden companion only the employer's suggestion fills (Lever's
//                location-input -> selectedLocation): flagged on the card; unresolved or picked after the yes, it is
//                never sent (the companion's value was never approved)
//   redirects    a loopback posting whose main frame is sent to another origin, by HTTP redirect or by script, in both
//                modes: stopped, and the other origin receives nothing
import assertNode from "node:assert/strict";
import { engineRunner, type Job, prepare, runApproved } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const VALUE = "Quorlen";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000d4";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-ro" };
const FACTS = {
  user_id: PERSON,
  answers: {
    first_name: { value: VALUE, factId: "RO-TEST-FACT-1", ...SOURCE },
    last_name: { value: "Tester", factId: "RO-TEST-FACT-2", ...SOURCE },
    email: { value: "quorlen.tester@example.test", factId: "RO-TEST-FACT-3", ...SOURCE },
    location: { value: "Oakvale, IL", factId: "RO-TEST-FACT-4", ...SOURCE },
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

const FIELDS = `<label for="first">First name</label><input name="first_name" id="first" required>
<label for="last">Last name</label><input name="last_name" id="last" required>
<label for="email">Email</label><input name="email" id="email" type="email" required>
<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>`;
const head = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST Boundary Employer</p>`;
// Every page reports what it sees typed, at once, by GET (allowed before any value): the witness of what was put in.
const watch = `<script>for (const e of document.querySelectorAll("input")) e.addEventListener("input", (x) => fetch("/typed?v=" + encodeURIComponent(x.target.value)).catch(() => {}));</script>`;
const lookup = (picks: boolean) => `${head}<form method="post" action="/submit" enctype="multipart/form-data">${FIELDS}
<label for="loc">Location</label><input class="location-input" id="loc" type="text" name="location">
<input id="selected-location" type="hidden" name="selectedLocation"><button type="submit">Submit application</button></form>${watch}
${picks ? `<script>document.getElementById("loc").addEventListener("input", (e) => { document.getElementById("selected-location").value = JSON.stringify({ name: e.target.value, id: "loc-1" }); });</script>` : ""}`;
const PAGES: Record<string, (other: string) => string> = {
  "/plain": () => `${head}<form method="post" action="/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>${watch}`,
  "/conditional": () => `${head}<form method="post" action="/submit" enctype="multipart/form-data">${FIELDS}<div id="more"></div><button type="submit">Submit application</button></form>${watch}
<script>let shown = false; document.getElementById("first").addEventListener("input", () => { if (shown) return; shown = true;
  document.getElementById("more").innerHTML = '<label for="ref">Who referred you?</label><input name="referrer" id="ref" required>'; });</script>`,
  "/multi": () => `${head}<form method="post" action="/submit" enctype="multipart/form-data">${FIELDS}<button type="button" id="next">Next</button></form>${watch}`,
  "/lookup-unpicked": () => lookup(false),
  "/lookup-picked": () => lookup(true),
  "/script-redirect": (other) => `${head}<form method="post" action="/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>
<script>setTimeout(() => { location.href = "${other}/landing?from=script"; }, 50);</script>`,
};

function server(other = "") {
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
    if (u.pathname === "/http-redirect") return new Response(null, { status: 302, headers: { location: `${other}/landing?from=http` } });
    const page = PAGES[u.pathname];
    return page ? new Response(page(other), { headers: { "content-type": "text/html" } }) : new Response("<!doctype html>landing", { headers: { "content-type": "text/html" } });
  });
  return { base: `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}`, log, close: () => s.shutdown() };
}
const carries = (log: string[]) => log.filter((l) => l.includes(VALUE));

// Prepare for real (read-only unless fill), then, if asked, drive the prepared application through runApproved as the
// queue would. Returns what the employer and the other origin received, before and after the approval.
async function run(path: string, o: { approve?: boolean; fill?: boolean } = {}) {
  const other = server();
  const site = server(other.base);
  const work = await Deno.makeTempDir({ prefix: "trainee-read-only-" });
  try {
    const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
    await Deno.writeTextFile(factsPath, JSON.stringify(FACTS));
    await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic\n%%EOF\n"));
    const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, ...(o.fill ? ["--discovery-fill"] : [])] });
    let dry: any = null;
    const prepared: any = await prepare({ url: `${site.base}${path}`, factsPath, resumePath, account: { epoch: 0, version: 0 }, now: Date.now(),
      runEngine: async (...a) => (dry = await runEngine(...a)) });
    await new Promise((ok) => setTimeout(ok, 1000)); // anything the page would still send after the prepare
    const beforeApproval = [...site.log], otherBefore = [...other.log];
    let finished: any = null;
    if (o.approve && prepared.ready) {
      const approvedEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const job: Job = { id: "44444444-4444-4444-8444-444444444444", lease_token: "55555555-5555-4555-8555-555555555555", url: `${site.base}${path}`, user_id: PERSON, payload: prepared.payload };
      let claimed = false;
      await runApproved({
        claim: async () => claimed ? [] : (claimed = true, [job]),
        finish: async (id, lease, state, evidence) => void (finished = { id, lease, state, evidence }),
        resumeFor: async () => ({ path: resumePath, sha256: prepared.payload.resume_sha256 }),
        writeFacts: async (_job, facts) => { const p = `${work}/approved-facts.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; },
        runEngine: approvedEngine,
      });
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    console.log(`${path}${o.fill ? " (fill)" : ""}: prepared ${JSON.stringify(prepared.ready ? "ready" : prepared.result)} finished ${JSON.stringify(finished && { state: finished.state, ...finished.evidence })}\n employer: ${JSON.stringify(site.log)}\n other: ${JSON.stringify(other.log)}`);
    return { prepared, dry, finished, beforeApproval, otherBefore, all: [...site.log], other: [...other.log] };
  } finally {
    await site.close();
    await other.close();
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

const opts = { sanitizeResources: false, sanitizeOps: false };
const guard = () => {
  if (!browserEnv()) { if (CI) throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright browser"); return false; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user"); return false; }
  return true;
};
const NOT_FILLED = /the form is not filled yet/;

Deno.test({
  ...opts,
  name: "read-only discovery: the prepare types nothing; its card and record say the form is not filled yet; the approved run sends exactly the approved answers, once",
  async fn() {
    if (!guard()) return;
    const r = await run("/plain", { approve: true });
    assert(r.prepared.ready, JSON.stringify(r.prepared.result));
    eq(carries(r.beforeApproval), [], "before the approval the employer received nothing carrying the person's value");
    eq(r.beforeApproval.filter((l) => l.startsWith("GET /typed")), [], "nothing was typed into the page before the approval");
    eq(r.prepared.payload.preparation, { verification: "planned_not_fill_verified", completeness: "unknown_until_filled", lookups: [] });
    assert(r.prepared.card.some((l: string) => NOT_FILLED.test(l)), `the card says it: ${JSON.stringify(r.prepared.card)}`);
    const posts = r.all.filter((l) => l.startsWith("POST "));
    eq(posts.length, 1, `exactly one application: ${JSON.stringify(posts)}`);
    assert(posts[0].includes(`first_name=${VALUE}`) && posts[0].includes("file:resume.pdf"), posts[0]);
    assert(["confirmed", "submitted_unconfirmed"].includes(r.finished?.state), JSON.stringify(r.finished));
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: a question that appears only once something is filled: nothing is sent, and the record says the application was incomplete, with the question",
  async fn() {
    if (!guard()) return;
    const r = await run("/conditional", { approve: true });
    assert(r.prepared.ready, "the prepare saw the form as it first stands");
    eq(r.prepared.payload.preparation.completeness, "unknown_until_filled", "never assumed complete");
    assert(r.prepared.card.some((l: string) => /asks something this card does not show, nothing is sent/.test(l)), JSON.stringify(r.prepared.card));
    eq(carries(r.beforeApproval), [], "before the approval the employer received nothing carrying the person's value");
    eq(r.all.filter((l) => l.startsWith("POST ")), [], "no application was sent");
    eq(r.finished?.state, "not_submitted", JSON.stringify(r.finished));
    eq([r.finished?.evidence?.reason, r.finished?.evidence?.incomplete], ["needs_answers", "QUESTION_APPEARED_AFTER_FILL"]);
    eq(r.finished?.evidence?.questions, ["Who referred you?"]);
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: a form with a step before its last page is not prepared before approval",
  async fn() {
    if (!guard()) return;
    const r = await run("/multi");
    eq([r.prepared.ready, r.prepared.result?.reason], [false, "MULTI_STEP_NEEDS_APPROVAL"], JSON.stringify(r.prepared.result));
    eq(carries(r.all), [], "the employer received nothing carrying the person's value");
    eq(r.all.filter((l) => l.startsWith("GET /typed")), [], "nothing was typed into the page");
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: a lookup whose answer is a hidden companion is flagged; left unresolved after the yes, nothing is sent",
  async fn() {
    if (!guard()) return;
    const r = await run("/lookup-unpicked", { approve: true });
    assert(r.prepared.ready, JSON.stringify(r.prepared.result));
    eq(r.prepared.payload.preparation.lookups, ["location"]);
    assert(r.prepared.card.some((l: string) => /^Location: the employer's own suggestion for it is picked only after you say yes/.test(l)), JSON.stringify(r.prepared.card));
    eq(r.all.filter((l) => l.startsWith("POST ")), [], "an unresolved lookup was not sent");
    eq([r.finished?.state, r.finished?.evidence?.reason], ["not_submitted", "LOOKUP_UNRESOLVED: Location"]);
  },
});

Deno.test({
  ...opts,
  name: "read-only discovery: the same lookup, picked by the page after the yes, is still not sent: its companion is a value the person never approved",
  async fn() {
    if (!guard()) return;
    // The employer's suggestion sets the hidden companion only after the yes, so the person could not have approved its
    // value: the engine refuses a hidden field the page set that the approval does not carry. Sending it needs an
    // approval of that value, at that stage (not built).
    const r = await run("/lookup-picked", { approve: true });
    eq(r.all.filter((l) => l.startsWith("POST ")), [], "not sent");
    eq([r.finished?.state, r.finished?.evidence?.reason], ["not_submitted", "UNCONFIRMED_HIDDEN_FIELD: selectedLocation"]);
  },
});

for (const fill of [false, true]) {
  for (const path of ["/http-redirect", "/script-redirect"]) {
    Deno.test({
      ...opts,
      name: `a loopback posting whose main frame goes to another origin (${path.slice(1)}, ${fill ? "filled" : "read-only"} discovery) is stopped; the other origin receives nothing`,
      async fn() {
        if (!guard()) return;
        const r = await run(path, { fill });
        assert(!r.prepared.ready, JSON.stringify(r.prepared.result));
        eq(r.prepared.result?.reason, "HOST_REDIRECT_REFUSED", JSON.stringify(r.prepared.result));
        eq(r.other, [], "the other origin received nothing");
        eq(carries(r.all), [], "the employer received nothing carrying the person's value");
      },
    });
  }
}
