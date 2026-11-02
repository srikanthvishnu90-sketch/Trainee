// The owner's first real application (Ramp, Software Engineering Intern, Frontend, Ashby), the links the Telegram path
// had MISSING or BUILT-UNTESTED on 2026-10-31 (docs/architect/RAMP-APPLY-TRACE-2026-10-31.md):
//
//   L1 (MISSING) every real Ashby form has no <form> post, so the engine binds its scripted Submit only on a host with the
//      owner's switch UPMORE_SCRIPT_SUBMIT_LIVE=1. The hosted runner never handed it to its sandboxes and the preparation
//      host's engine environment dropped it: Ramp's card could never be prepared, nor sent, whatever the switch said.
//   L2 (BUILT-UNTESTED) the live page's own shape: the form shown only after a read-only GraphQL query, and the
//      application sent as ONE GraphQL multipart request (operations + map + the resume as a file part). Driven here with
//      the production preparation (approve-first.ts prepare, the product's ask-once rows) and the production cloud
//      submitter (worker.ts runCloudJob + cloudEngineRunner, the code a send sandbox runs), and the posted request
//      compared with the approved card byte for byte.
//   L3 a verification check (reCAPTCHA Enterprise's challenge) at load or at Submit hands the job back (needs_user,
//      bot_check): nothing reaches the employer, it is never solved, never retried.
//   L4 the architect's dry run on the real page (scripts/career/ramp-dry-run.ts) fills and reads back every field and
//      stops at the review: run here against the stand-in, it never sends.
//
// Synthetic persona and a loopback server only (tests/helpers/ashby_live_shape.ts). Nothing reaches Ramp or Ashby.
import assertNode from "node:assert/strict";
import { scriptSubmitFamily } from "../../scripts/apply.ts";
import { vercelSandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { sandboxHostOptions } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { PREPARE_ENGINE_ENV_KEYS, prepareEngineEnv } from "../../workers/career-browser/prepare-ahead.ts";
import { cloudEngineRunner, type CloudJob, type CloudQueue, engineEnv, runCloudJob } from "../../workers/career-cloud/worker.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { dryEngine, dryRunLoop } from "../../scripts/career/ramp-dry-run.ts";
import { ashbyLiveShapeSite, RAMP_JOB, RAMP_LINK } from "../helpers/ashby_live_shape.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const persona = JSON.parse(Deno.readTextFileSync(`${ROOT}/tests/fixtures/ramp/persona-test.json`));
const FILE = new TextEncoder().encode(persona.file.text), FILE_NAME = String(persona.file.name);
const hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))).map((n) => n.toString(16).padStart(2, "0")).join("");
const FILE_SHA = await hex(FILE);
const b64 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); };

// ------------------------------------------------------------------------------------------------ L1: the owner's switch

Deno.test("L1a the engine binds a real Ashby posting's scripted Submit only with --script-submit ashby or UPMORE_SCRIPT_SUBMIT_LIVE=1", () => {
  const real = { local: false, family: "ashby", personSubmits: false };
  eq(scriptSubmitFamily({ ...real, flag: null, live: false }), null, "no switch: Ramp stops at SUBMIT_DESTINATION_NOT_BOUND");
  eq(scriptSubmitFamily({ ...real, flag: null, live: true }), "ashby", "the owner's switch on the host");
  eq(scriptSubmitFamily({ ...real, flag: "ashby", live: false }), "ashby");
  eq(scriptSubmitFamily({ ...real, flag: null, live: true, personSubmits: true }), null, "the person's own Submit binds nothing");
  eq(scriptSubmitFamily({ ...real, family: "smartrecruiters", flag: null, live: true }), null, "only the three scripted families");
  eq(scriptSubmitFamily({ local: true, family: null, personSubmits: false, flag: null, live: true }), null, "a local page names its family itself; the switch is for real hosts");
  eq(scriptSubmitFamily({ local: true, family: null, personSubmits: false, flag: "ashby", live: false }), "ashby");
});

Deno.test("L1b the hosted runner hands UPMORE_SCRIPT_SUBMIT_LIVE=1 to both sandboxes (preparation and send) when, and only when, its secret is set", async () => {
  const sent: any[] = [];
  const f = (async (_u: string | URL | Request, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response("{}"); }) as typeof fetch;
  const secrets = (extra: Record<string, string>) => (k: string) => ({ VERCEL_TOKEN: "TEST-vercel-token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "p",
    CLOUD_SANDBOX_SNAPSHOT_ID: "snap", SUPABASE_SERVICE_ROLE_KEY: "TEST-service-key", ...extra } as Record<string, string>)[k] ?? "";
  const on = vercelSandboxHost(sandboxHostOptions(secrets({ UPMORE_SCRIPT_SUBMIT_LIVE: "1" }), f));
  await on.run("sbx1", { CLOUD_JOB_ID: "j" }, "workers/career-cloud/prepare-runner.ts");
  await on.run("sbx2", { CLOUD_JOB_ID: "j" });
  eq(sent.map((b) => b.env.UPMORE_SCRIPT_SUBMIT_LIVE), ["1", "1"], "the same switch for the card's preparation and its send, so the destination prepared is the one bound");
  for (const b of sent) {
    assert(!JSON.stringify(b.env).includes("TEST-service-key") && !JSON.stringify(b.env).includes("TEST-vercel-token"), "no secret of the function reaches a sandbox");
  }
  sent.length = 0;
  for (const v of ["", "0", "true", "on"]) {
    const off = vercelSandboxHost(sandboxHostOptions(secrets(v ? { UPMORE_SCRIPT_SUBMIT_LIVE: v } : {}), f));
    await off.run("sbx3", {});
  }
  eq(sent.map((b) => Object.hasOwn(b.env, "UPMORE_SCRIPT_SUBMIT_LIVE")), [false, false, false, false], "only the exact value 1 turns it on");
});

Deno.test("L1c the preparation host's engine and the send worker's engine both see the switch, and no secret", () => {
  const host: Record<string, string> = { PATH: "/bin", HOME: "/h", UPMORE_SCRIPT_SUBMIT_LIVE: "1", SUPABASE_SERVICE_ROLE_KEY: "TEST-key", CAREER_PREPARE_AHEAD_TOKEN: "TEST-token" };
  const get = (k: string) => host[k];
  assert(PREPARE_ENGINE_ENV_KEYS.includes("UPMORE_SCRIPT_SUBMIT_LIVE"));
  eq(prepareEngineEnv(get).UPMORE_SCRIPT_SUBMIT_LIVE, "1", "the preparation's dry run binds Ashby's Submit as the send will");
  eq(engineEnv(get).UPMORE_SCRIPT_SUBMIT_LIVE, "1", "the send worker's engine (unchanged)");
  for (const env of [prepareEngineEnv(get), engineEnv(get)]) {
    assert(!Object.values(env).some((v) => /TEST-key|TEST-token/.test(v)), JSON.stringify(env));
  }
});

// ------------------------------------------------------------------------------------------------ L2-L4: the real engine

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
const runnable = () => {
  if (!browserEnv()) {
    if (CI) throw Error("the Ramp submit path needs the gate's Playwright browser in CI");
    console.log("NOT_RUN locally: no Playwright browser");
    return false;
  }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return false; }
  return true;
};

const USER = "TEST-ramp-00000000-0000-4000-8000-000000000931";

// The approved card, prepared exactly as the preparation sandbox prepares it, with the product's ask-once loop.
async function prepared(site: ReturnType<typeof ashbyLiveShapeSite>, work: string) {
  const resumePath = `${work}/${FILE_NAME}`;
  await Deno.writeFile(resumePath, FILE);
  const engine = dryEngine({ extra: ["--script-submit", "ashby", "--state-dir", `${work}/state`], evidenceRoot: `${work}/prep-evidence` });
  const r = await dryRunLoop({ url: site.form, userId: USER, company: "Ramp", persona, resumePath, work, runEngine: engine });
  return { r, engine, resumePath };
}

function memoryQueue(job: CloudJob) {
  const phases: string[] = [], finished: any[] = [];
  const queue: CloudQueue = {
    claim: async () => [],
    // Named stand-in for the bridge's live authorization (current_sources.ts, proven in cloud-runner.test.ts and
    // flow-hosted-apply step 6): it records each phase; the payload/hash checks in runCloudJob run as written.
    authorize: async (_j, phase) => { phases.push(phase); },
    resume: async () => ({ filename: FILE_NAME, sha256: FILE_SHA, b64: b64(FILE) }),
    ask: async () => 0,
    finish: async (_j, state, evidence, outcome, errorKind) => { finished.push({ state, evidence, outcome, errorKind }); return { state }; },
    gatePresent: async () => true,
  };
  return { queue, phases, finished, job };
}

async function approvedJob(payload: any): Promise<CloudJob> {
  const h = await hashApplyPayload(payload);
  return { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), user_id: payload.user_id, company: payload.company, url: payload.url,
    payload, payload_hash: h, approval_hash: h, job_id: payload.job_id };
}

// The cloud engine as a send sandbox runs it (its own process, no secret in its env, the effect authorized over stdio),
// told this loopback page stands in for an Ashby form; a real posting gets the same binding from UPMORE_SCRIPT_SUBMIT_LIVE.
const sendEngine = (work: string) => {
  const e = cloudEngineRunner({ root: ROOT, evidenceRoot: `${work}/send-evidence` });
  return ((args, env, controls) => e([...args, "--script-submit", "ashby"], env, controls)) as typeof e;
};

Deno.test({
  name: "L2 Ramp's live shape: prepared from the GraphQL-loaded form, asked only what is missing, then the cloud submitter sends ONE multipart mutation equal to the approved card byte for byte",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!runnable()) return;
    const site = ashbyLiveShapeSite();
    const work = await Deno.makeTempDir({ prefix: "ramp-ashby-" });
    try {
      // Without the binding a real Ashby form cannot even be prepared (the stop L1 removes on a live host).
      const unbound = dryEngine({ extra: ["--state-dir", `${work}/state0`], evidenceRoot: `${work}/unbound` });
      await Deno.writeFile(`${work}/r0.pdf`, FILE);
      const r0 = await dryRunLoop({ url: site.form, userId: USER, company: "Ramp", persona, resumePath: `${work}/r0.pdf`, work, runEngine: unbound });
      eq([r0.status, r0.reason], ["stopped", "SUBMIT_DESTINATION_NOT_BOUND"], JSON.stringify(r0));
      eq(site.applications.length, 0);

      const { r } = await prepared(site, work);
      eq(r.status, "ready", JSON.stringify(r));
      assert(site.reads.length >= 1, "the form came from the read-only ApiJobPosting query");
      // Asked only what the form requires and the facts did not hold, each once; optional questions never asked.
      const labels = r.questions.map((q) => q.label);
      eq(new Set(r.questions.map((q) => q.key)).size, r.questions.length, "each question asked once");
      for (const optional of ["Pronouns", "LinkedIn Profile", "Degree", "Field of Study", "Still Student?"]) assert(!labels.includes(optional), `${optional} is optional: never asked`);
      const required = site.schema.filter((f) => f.required && f.path !== "_systemfield_resume");
      const payload = r.payload, card = r.card!;
      for (const f of required) assert(payload.fields.some((x: any) => x.name === f.path), `${f.title} is answered on the card`);
      assert(payload.fields.every((f: any) => /^text-answer:\d+$|^approved-local-resume:/.test(f.factId)), `every answer is the person's own (asked and answered), none invented: ${JSON.stringify(payload.fields.map((f: any) => f.factId))}`);
      eq(payload.resume_sha256, FILE_SHA);
      assert(/non-user-graphql \(one request, the application mutation/.test(payload.destination), payload.destination);
      assert(card.includes(`Sends to ${payload.destination}`), "the card says where it goes");

      // The tap: the approved card's payload becomes the job, its hash the approval. The production submitter runs it.
      const job = await approvedJob(payload);
      const q = memoryQueue(job);
      const done: any = await runCloudJob(job, { queue: q.queue, runEngine: sendEngine(work), tmpRoot: work, log: () => {} });
      eq([done.state, done.outcome], ["confirmed", "submitted"], JSON.stringify(done));
      eq(q.phases, ["before_engine", "before_engine", "before_effect"], "authorized before the engine and again before the one Submit");
      eq(q.finished.length, 1, "recorded once");
      const ev = q.finished[0].evidence;
      eq([ev.confirmation_id, ev.response?.status], ["RAMP-ASHBY-0931", 200], "the page's confirmation and the employer's response code are the record");
      assert(/^[0-9a-f]{64}$/.test(String(ev.screenshots?.sha256?.["after-submit.png"] ?? "")), `the confirmation page's screenshot, by its hash: ${JSON.stringify(ev.screenshots)}`);

      // Exactly one application, as Ashby's client sends it.
      eq(site.applications.length, 1, `one mutation; other requests: ${JSON.stringify(site.other)}`);
      const sent = site.applications[0];
      eq(sent.url, "/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction");
      eq([sent.operations.variables.organizationHostedJobsPageName, sent.operations.variables.jobPostingId], ["ramp", RAMP_JOB]);
      eq(sent.map, { "0": ["variables.resume"] });
      eq(sent.files.length, 1, "one file part: the resume");
      eq([sent.files[0].part, sent.files[0].name, await hex(sent.files[0].bytes)], ["0", FILE_NAME, payload.resume_sha256], "the approved resume, byte for byte");

      // Byte for byte: the posted field entries, canonical, equal the approved card's answers, canonical. The one
      // transformation is the page's own: a yes/no button travels as a boolean (the card shows Yes/No).
      const approvedFields = (payload.fields as any[]).filter((f) => f.name !== "_systemfield_resume");
      const yesNo = new Set(approvedFields.filter((f) => typeof (sent.operations.variables.applicationForm.fieldEntries as any[])
        .find((e) => e.field === f.name)?.value === "boolean").map((f) => f.name));
      const canon = (rows: [string, string][]) => JSON.stringify(rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
      const want = canon(approvedFields.map((f) => [f.name, yesNo.has(f.name) ? String(/^(yes|true)$/i.test(String(f.value))) : String(f.value)]));
      const got = canon((sent.operations.variables.applicationForm.fieldEntries as any[]).map((e) => [e.field, String(e.value)]));
      eq(got, want, "every approved answer sent exactly, nothing else sent");
      // And each card line shows the value that went: a choice by the page's own label for the option code sent (the form's
      // schema as approved, payload.approved_snapshot), a yes/no as Yes/No, a typed answer as typed.
      const schema: any[] = payload.approved_snapshot.schema;
      for (const f of approvedFields) {
        const opt = (schema.find((x) => x.name === f.name)?.options ?? []).find((o: any) => o.value === f.value);
        const shown = yesNo.has(f.name) ? (/^(yes|true)$/i.test(String(f.value)) ? ["Yes (checked)", "Yes"] : ["No"]) : [opt ? String(opt.label) : String(f.value)];
        assert(card.some((l) => shown.some((v) => l.endsWith(`${f.label}: ${v}`))), `the card shows ${f.label} as sent (${shown}): ${card.join(" | ")}`);
      }
      eq(card.slice(1).filter((l) => !/^(Resume: |Sends to |Also sent, |The page runs )/.test(l)).length, approvedFields.length,
        "one card line per answer sent, no more");
    } finally {
      await site.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "L2b a page that changes an approved answer at Submit is stopped before anything leaves; nothing reaches the employer",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!runnable()) return;
    const site = ashbyLiveShapeSite();
    const work = await Deno.makeTempDir({ prefix: "ramp-ashby-" });
    try {
      const { r } = await prepared(site, work);
      eq(r.status, "ready", JSON.stringify(r));
      site.set({ mode: "tamper" });
      const job = await approvedJob(r.payload);
      const q = memoryQueue(job);
      const done: any = await runCloudJob(job, { queue: q.queue, runEngine: sendEngine(work), tmpRoot: work, log: () => {} });
      eq(site.applications.length, 0, "the changed application never reached the employer");
      assert(!["confirmed", "submitted_unconfirmed"].includes(done.state), JSON.stringify(done));
      assert(!q.phases.includes("before_effect"), `the effect was never authorized: ${q.phases}`);
    } finally {
      await site.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "L3 reCAPTCHA's challenge at Submit and at load: needs_user / bot_check, never solved, nothing sent, never retried",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!runnable()) return;
    const site = ashbyLiveShapeSite();
    const work = await Deno.makeTempDir({ prefix: "ramp-ashby-" });
    try {
      const { r } = await prepared(site, work);
      eq(r.status, "ready", JSON.stringify(r));
      for (const at of ["submit", "open"] as const) {
        site.set({ challenge: at });
        const job = await approvedJob(r.payload);
        const q = memoryQueue(job);
        let runs = 0;
        const engine = sendEngine(work);
        const counted: typeof engine = (a, e, c) => { runs++; return engine(a, e, c); };
        const done: any = await runCloudJob(job, { queue: q.queue, runEngine: counted, tmpRoot: work, log: () => {} });
        eq([done.state, done.outcome], ["needs_user", "bot_check"], `${at}: ${JSON.stringify(done)}`);
        eq(site.applications.length, 0, `${at}: nothing reached the employer`);
        eq(runs, 1, `${at}: driven once, never retried`);
        assert(!q.phases.includes("before_effect"), `${at}: no Submit was ever authorized`);
        eq(q.finished.length, 1);
      }
    } finally {
      await site.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "L4 the architect's dry run (scripts/career/ramp-dry-run.ts) on the stand-in: every field filled and read back, a screenshot and the field map saved, nothing sent",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!runnable()) return;
    const site = ashbyLiveShapeSite();
    const work = await Deno.makeTempDir({ prefix: "ramp-dry-cli-" });
    try {
      const out = `${work}/out`;
      const refused = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", `${ROOT}/scripts/career/ramp-dry-run.ts`, "--persona",
        `${ROOT}/tests/fixtures/ramp/persona-test.json`, "--out", out, "--url", site.form, "--submit"], stdout: "piped", stderr: "piped" }).output();
      eq(refused.code, 2, "a --submit is refused before anything opens");
      const p = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", `${ROOT}/scripts/career/ramp-dry-run.ts`, "--persona",
        `${ROOT}/tests/fixtures/ramp/persona-test.json`, "--out", out, "--url", site.form], stdout: "piped", stderr: "piped" }).output();
      const said = new TextDecoder().decode(p.stdout).trim().split("\n").at(-1)!;
      eq(p.code, 0, `${said}\n${new TextDecoder().decode(p.stderr).slice(-2000)}`);
      const summary = JSON.parse(said);
      eq([summary.status, summary.submitted, summary.unanswered], ["ready", false, []]);
      const map = JSON.parse(await Deno.readTextFile(`${out}/field-map.json`));
      for (const f of site.schema.filter((x) => x.required)) assert(map.fields.some((x: any) => x.name === f.path), `${f.title} in the field map`);
      assert(map.left_empty.every((x: any) => !x.required), `only optional fields left empty: ${JSON.stringify(map.left_empty)}`);
      for (const f of map.fields.filter((x: any) => x.name !== "_systemfield_resume")) assert(Object.hasOwn(map.readback, f.name), `${f.label} read back from the page`);
      const png = await Deno.readFile(`${out}/before-review.png`);
      eq([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG", "the filled form at the review");
      assert((await Deno.readTextFile(`${out}/card.txt`)).includes("Sends to "), "the card as the owner will read it");
      eq(site.applications.length, 0, "the dry run sent nothing");
      assert(!site.other.some((o) => /ApiSubmit/.test(o)), JSON.stringify(site.other));
    } finally {
      await site.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
