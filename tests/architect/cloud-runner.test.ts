// F-RUNNER (docs/launch/CLOUD-RUNNER.md): the horizontally scalable cloud runner. A dispatcher claims approved
// applications through the one cloud claim (career_apply_cloud_dispatch_claim -> career_apply_cloud_claim_portal_at, the
// installed claim_at with a family filter) and starts one sandbox per application; each sandbox runs the existing engine
// for its one job through the job bridge (supabase/functions/_shared/cloud_runner.ts) and finishes it with
// career_apply_cloud_finish. Nothing here reaches a real employer: the portal-hosted jobs in part 2 are never opened
// (their engine is a scripted stand-in), and the real engine in part 3 drives a page on 127.0.0.1.
//
//   1. no database: retries with backoff, a sandbox that cannot start ends RUNNER_UNAVAILABLE (never left to the sweep),
//      the bridge's token binds one job, one lease and one sandbox, and the job, lease and person come from the database.
//   2. real Postgres (CI's migration order), the real dispatch claim and the real bridge: global and per-portal limits,
//      a verification check ends needs_user and is counted per host, the live authorization refuses without its source
//      functions (the draft bridge is not installed here), a started sandbox is stopped at the finish.
//   3. real Postgres and the real engine in Chromium on a local form: the engine's dry run prepares, then the sandbox
//      runner submits exactly the approved application once, records it, and reads back submitted_unconfirmed.
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import assertNode from "node:assert/strict";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { type ClaimedJob, dispatch, handleBridge, jobToken, type Rpc, type SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { bridgeQueue, runSandboxJob } from "../../workers/career-cloud/sandbox-runner.ts";
import { cloudEngineRunner } from "../../workers/career-cloud/worker.ts";
import { engineApprovalFromPayload, factsFromPayload, prepare } from "../../workers/career-browser/approve-first.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";
import { effectAware } from "../helpers/cloud_card_auth.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const SECRET = "TEST-runner-secret-0123456789abcdef0123456789";
const noSleep = async () => {};

// The sandbox's HTTP calls to the bridge, answered in process by the bridge's own handler, as JSON both ways.
function bridgeFetch(deps: Parameters<typeof handleBridge>[2]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const op = String(input).split("/job/")[1];
    const out = await handleBridge(op, JSON.parse(String(init?.body ?? "null")), deps);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const pgRpc = (pg: Pg): Rpc => async (name, args) => {
  const r = await pg.asService().rpc(name, args);
  if (r.error) throw Error(r.error.message);
  return r.data;
};
const pgReadJob = (pg: Pg) => async (id: string): Promise<ClaimedJob | null> => {
  const out = await pg.sql(`select coalesce((select row_to_json(j) from (select id, lease_token, user_id, company, url, payload, payload_hash,
    approval_hash, job_id, state, source from public.career_apply_jobs where id = '${id.replace(/[^0-9a-f-]/g, "")}') j)::text, 'null')`);
  return JSON.parse(out.split("\n").at(-1)!);
};
// A fake Vercel: sandbox ids, which runs were started with what env, which were stopped; `failCreate` names job ids
// whose sandbox never comes up.
function fakeHost(o: { onRun: (sandbox: string, env: Record<string, string>) => void; failCreate?: (name: string) => boolean }) {
  const created: string[] = [], stopped: string[] = [], runs: Record<string, Record<string, string>> = {};
  let creates = 0;
  const host: SandboxHost = {
    create: async ({ name }) => {
      creates++;
      if (o.failCreate?.(name)) throw Error("vercel /v4/sandboxes: 429 rate limited (TEST)");
      const id = `sbx_TEST${created.length + 1}`;
      created.push(id);
      return id;
    },
    run: async (sandbox, env) => {
      runs[sandbox] = env;
      o.onRun(sandbox, env);
    },
    stop: async (sandbox) => {
      stopped.push(sandbox);
    },
  };
  return { host, created, stopped, runs, creates: () => creates };
}

Deno.test("F-RUNNER 1: dispatcher retries and gives up honestly; the bridge token binds one job, one lease, one sandbox", async () => {
  const lease = "11111111-2222-4333-8444-555555555555", id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const finished: any[] = [];
  const rpc: Rpc = async (name, args) => {
    if (name === "career_apply_cloud_dispatch_claim") {
      eq(args, { p_want: 5, p_global: 3, p_per_portal: 2 }, "the limits go to the database as given");
      return [{ id, lease_token: lease, user_id: "u", company: "c", url: "https://jobs.lever.co/x/1", payload: {}, payload_hash: "h", approval_hash: "h" }];
    }
    if (name === "career_apply_cloud_finish") { finished.push(args); return { state: "not_submitted" }; }
    throw Error("unexpected " + name);
  };
  const slept: number[] = [];
  const f = fakeHost({ onRun: () => {}, failCreate: () => true });
  const r = await dispatch({ rpc, host: f.host, secret: SECRET, bridgeUrl: "https://bridge.test", limits: { want: 5, global: 3, perPortal: 2 },
    retry: { tries: 3, baseMs: 1000, sleep: async (ms) => { slept.push(ms); } }, log: () => {} });
  eq(f.creates(), 3, "three tries to start a sandbox");
  assert(slept.length === 2 && slept[0] >= 750 && slept[0] <= 1250 && slept[1] >= 1500 && slept[1] <= 2500, `backoff 1 s then 2 s (jittered): ${slept}`);
  eq(r.unavailable.map((u) => u.job), [id]);
  eq(finished.length, 1, "the application is finished, not left to the 15-minute sweep");
  eq([finished[0].p_state, finished[0].p_outcome, finished[0].p_error_kind, finished[0].p_lease], ["not_submitted", "not_sent", "RUNNER_UNAVAILABLE", lease]);

  // A queue that cannot be read: nothing claimed, nothing started.
  const down = await dispatch({ rpc: async () => { throw Error("503"); }, host: f.host, secret: SECRET, bridgeUrl: "x",
    limits: { want: 1, global: 1, perPortal: 1 }, retry: { sleep: noSleep }, log: () => {} });
  eq([down.claimed, down.started.length, typeof down.claim_error], [0, 0, "string"]);

  // The bridge: the database's row decides; the request names nothing but its token.
  const calls: { name: string; args: any }[] = [];
  let row: any = { id, lease_token: lease, user_id: "person-1", company: "c", url: "u", payload: {}, payload_hash: "h", approval_hash: "h", state: "driving", source: "cloud" };
  const deps = { secret: SECRET, readJob: async () => row, rpc: async (name: string, args: any) => { calls.push({ name, args }); return { authorized: true }; } };
  const token = await jobToken(SECRET, id, lease, "sbx_A");
  eq((await handleBridge("job", { id, sandbox: "sbx_A", token }, deps)).status, 200);
  eq((await handleBridge("job", { id, sandbox: "sbx_B", token }, deps)).status, 403, "another sandbox's token is refused");
  eq((await handleBridge("job", { id, sandbox: "sbx_A", token: await jobToken(SECRET + "x", id, lease, "sbx_A") }, deps)).status, 403, "a token under another secret is refused");
  await handleBridge("authorize", { id, sandbox: "sbx_A", token, p_hash: "H", p_source_digest: "D", p_lease: "forged", p_id: "forged" }, deps);
  await handleBridge("sources", { id, sandbox: "sbx_A", token, p_user: "someone-else" }, deps);
  eq(calls.map((c) => c.args), [{ p_id: id, p_lease: lease, p_hash: "H", p_source_digest: "D" }, { p_user: "person-1" }],
    "the job, its lease and its person come from the database, never from the request");
  eq((await handleBridge("drop", { id, sandbox: "sbx_A", token }, deps)).status, 404, "only the six operations");
  row = { ...row, state: "needs_user" };
  eq((await handleBridge("resume", { id, sandbox: "sbx_A", token }, deps)).status, 403, "a finished job is no one's any more");
  row = { ...row, state: "driving", lease_token: "99999999-2222-4333-8444-555555555555" };
  eq((await handleBridge("resume", { id, sandbox: "sbx_A", token }, deps)).status, 403, "a token for an earlier lease is refused");
});

// ------------------------------------------------------------------------------------------------ parts 2 and 3: Postgres

const RESUME = new TextEncoder().encode("%PDF-1.4\n% synthetic runner resume\n%%EOF\n");
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME))).map((b) => b.toString(16).padStart(2, "0")).join("");
const P1 = "7b0f8f8e-6a43-4a49-9d2c-0000000000a1", P2 = "7b0f8f8e-6a43-4a49-9d2c-0000000000a2";
async function people(pg: Pg, ids: string[], portals: string[]) {
  for (const u of ids) {
    await pg.sql(`insert into auth.users (id, email) values ('${u}', '${u.slice(-2)}@example.test');
      insert into public.profiles (id) values ('${u}');
      insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":1,"version":1,"paused":false}');
      ${confirmedResumeSql(u)}
      select public.career_apply_cloud_optin_as('${u}', true, 'TEST terms');
      insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
       values ('${u}', '${RESUME_SHA}', 'resume.pdf', decode('${btoa(String.fromCharCode(...RESUME))}', 'base64'), 1);`);
    for (const f of portals) {
      await pg.sql(`insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note) values ('${u}', '${f}', 5, now() + interval '1 day', 'TEST runner');`);
    }
  }
  await pg.sql(`delete from public.career_cloud_settings where key = 'CAREER_CLOUD_APPLY'; insert into public.career_cloud_settings (key, value) values ('CAREER_CLOUD_APPLY', 'on');`);
}
// An approved application as the card's yes enqueues it (career_apply_enqueue with the payload's own hash). Its manifest
// hash is the one the live authorization recomputes from the payload (current_sources.ts), so only the database's
// answers can refuse it.
async function queued(pg: Pg, u: string, n: number, url: string) {
  const payload: any = { version: 1, user_id: u, job_id: `TEST-RUNNER-${n}`, company: `Runner Employer ${n}`, url, fields: [],
    privacy_epoch: 1, account_version: 1, expires_at: new Date(Date.now() + 3600_000).toISOString(), engine_approval: "e".repeat(64),
    resume_sha256: RESUME_SHA, destination: url, schema_hash: "c".repeat(64), replay_sources: [], page_field_names: [] };
  const frozen = factsFromPayload(payload);
  payload.manifest_hash = trustedManifest({ owner: u, file: frozen, rows: frozen.text_answers ?? [], resume: { sha256: payload.resume_sha256 } }).hash;
  payload.engine_approval = await engineApprovalFromPayload(payload);
  const q = `$p$${JSON.stringify(payload)}$p$::jsonb`;
  return await pg.sql(`select (public.career_apply_enqueue(${q}, public.career_apply_payload_hash(${q}), public.career_apply_payload_hash(${q}), null)).id`);
}
const ready = () => {
  if (!pgBinDir()) {
    if (CI) throw Error("F-RUNNER needs Postgres 16 binaries in CI");
    console.log("NOT_RUN locally: no Postgres binaries");
    return false;
  }
  return true;
};

Deno.test({
  name: "F-RUNNER 2: the dispatcher on a real database: limits, one sandbox per application, a check handed back, the live authorization, read-back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!ready()) return;
    const pg = await startPg();
    try {
      await people(pg, [P1, P2], ["greenhouse", "lever"]);
      const ids: Record<string, string> = {
        gh1: await queued(pg, P1, 1, "https://job-boards.greenhouse.io/runnerone/jobs/1"),
        gh2: await queued(pg, P2, 2, "https://job-boards.greenhouse.io/runnertwo/jobs/2"),
        lv3: await queued(pg, P1, 3, "https://jobs.lever.co/runnerthree/3"),
        gh4: await queued(pg, P1, 4, "https://job-boards.greenhouse.io/runnerfour/jobs/4"),
        lv5: await queued(pg, P2, 5, "https://jobs.lever.co/runnerfive/5"),
      };
      const rpc = pgRpc(pg), readJob = pgReadJob(pg);
      const runs: Promise<unknown>[] = [];
      const results: Record<string, any> = {};
      const engineSaw: string[] = [];
      // The scripted engine for portal-hosted jobs (never opened): Greenhouse sends, Lever shows a verification check.
      const engine = effectAware(async (args: string[]) => {
        const url = args[args.indexOf("--url") + 1];
        engineSaw.push(url);
        if (url.includes("lever.co")) return { result: { state: "needs_user", reason: "captcha" }, evidence: null };
        return { result: { state: "submitted_unconfirmed", reason: "page said received", confirmation_id: "TEST-" + url.split("/").pop() }, evidence: null };
      });
      // A named stand-in for the live authorization's two source functions, which only the draft card-cloud bridge
      // installs; gh2 keeps the real one, which must refuse here.
      const allow = new Set([ids.gh1, ids.lv3, ids.gh4]);
      let f!: ReturnType<typeof fakeHost>;
      f = fakeHost({
        failCreate: (name) => name.startsWith(`trainee-run-${ids.lv5.slice(0, 8)}`),
        onRun: (sandbox, env) => {
          eq(Object.keys(env).sort(), ["CLOUD_BRIDGE_URL", "CLOUD_JOB_ID", "CLOUD_JOB_TOKEN", "CLOUD_SANDBOX_ID"], "the sandbox gets four values and no credential");
          const bridge = bridgeQueue({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_JOB_ID, sandbox, token: env.CLOUD_JOB_TOKEN,
            fetch: bridgeFetch({ rpc, readJob, secret: SECRET, stop: f.host.stop }) });
          runs.push(runSandboxJob({ bridge, runEngine: engine as any, log: () => {},
            queue: (q) => allow.has(env.CLOUD_JOB_ID) ? { ...q, authorize: async () => {} } : q })
            .then((r) => { results[env.CLOUD_JOB_ID] = r; }));
        },
      });
      const r = await dispatch({ rpc, host: f.host, secret: SECRET, bridgeUrl: "https://bridge.test/functions/v1/career-cloud-runner",
        limits: { want: 10, global: 4, perPortal: 2 }, retry: { sleep: noSleep }, log: () => {} });
      eq(r.claimed, 4, "the global limit: four of five");
      const claimed = JSON.parse(await pg.sql(`select json_agg(id order by id) from public.career_apply_jobs where source = 'cloud'`));
      assert(!claimed.includes(ids.gh4), "Greenhouse held at its limit of two: its third application waits");
      eq(r.unavailable.map((u) => u.job), [ids.lv5], "the application whose sandbox never came up");
      eq(r.started.length, 3);
      await Promise.all(runs);
      eq(engineSaw.sort(), ["https://job-boards.greenhouse.io/runnerone/jobs/1", "https://jobs.lever.co/runnerthree/3"],
        "the engine ran only where the authorization allowed it, once each");

      const row = async (id: string) => JSON.parse(await pg.sql(`select row_to_json(j) from (select state, reason, attempts, confirmation_id,
        evidence->>'by' by_, evidence->>'handed_back' handed_back from public.career_apply_jobs where id = '${id}') j`));
      eq((await row(ids.gh1)).state, "submitted_unconfirmed");
      eq((await row(ids.gh1)).confirmation_id, "TEST-1");
      eq((await row(ids.gh1)).by_, "cloud");
      const bot = await row(ids.lv3);
      eq([bot.state, bot.reason], ["needs_user", "bot_check"], "a verification check is handed back to the person");
      assert(/finishes it at the link/.test(bot.handed_back), "with its link");
      const refused = await row(ids.gh2);
      eq([refused.state, refused.reason], ["not_submitted", "CARD_CLOUD_SOURCE_READ_FAILED"], "the live authorization refuses without its source functions: nothing sent");
      const unavailable = await row(ids.lv5);
      eq([unavailable.state, unavailable.reason, unavailable.attempts], ["not_submitted", "RUNNER_UNAVAILABLE", 1]);
      eq(f.stopped.sort(), [...f.created].sort(), "every started sandbox is stopped at its finish");

      // The numbers the fallback is decided from.
      const rates = await rpc("career_apply_cloud_check_rates", { p_days: 7 });
      const lever = rates.hosts.find((h: any) => h.host === "jobs.lever.co");
      eq([lever.attempts, lever.bot_checks, lever.bot_check_rate], [2, 1, 0.5], "per host: 1 check in 2 attempts (the not-started one counts as an attempt)");
      // A checked application is never claimed again, and a paused Lever is not dispatched to; Greenhouse's waiting application
      // goes next. One verification check no longer pauses a portal by itself (#384: the bot-check rule is 2 in the last 20 attempts,
      // tests/db/career_apply_mass_throughput.test.sql), so the pause this step needs is the one two checks would have made.
      await pg.sql(`insert into public.career_apply_cloud_pauses (scope, portal, reason, until, created_at)
        values ('portal', 'lever', 'bot_check_spike: 2 bot checks in the last 20 attempts', now() + interval '6 hours', now())`);
      const again = await dispatch({ rpc, host: f.host, secret: SECRET, bridgeUrl: "https://bridge.test", limits: { want: 10, global: 4, perPortal: 2 },
        retry: { sleep: noSleep }, log: () => {} });
      await Promise.all(runs);
      eq(again.started.map((s) => s.job), [ids.gh4]);
      eq(await pg.sql(`select count(*) from public.career_apply_cloud_pauses where scope = 'portal' and portal = 'lever'`), "1");
    } finally {
      await pg.stop();
    }
  },
});

// ------------------------------------------------------------------------------------------------ part 3: the real engine

function employer() {
  let posts = 0, upload = "";
  const form = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST Runner Employer</p><form method="post" action="/plain/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (req.method === "POST") {
      const data = await req.formData(), file = data.get("resume");
      if (file instanceof File) upload = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map((b) => b.toString(16).padStart(2, "0")).join("");
      posts++;
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: RUNNER-1.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (new URL(req.url).pathname === "/plain") return new Response(form, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  return { base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, posts: () => posts, upload: () => upload, close: () => server.shutdown() };
}
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

Deno.test({
  name: "F-RUNNER 3: the sandbox runner with the real engine: dry run, then the approved application to a local form once, recorded and read back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!ready()) return;
    if (!browserEnv()) {
      if (CI) throw Error("F-RUNNER 3 needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-runner-" });
    try {
      await people(pg, [P1], []);
      const source = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-runner-test" };
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify({ user_id: P1, answers: {
        first_name: { value: "Runner", factId: "RUNNER-TEST-1", ...source },
        last_name: { value: "Tester", factId: "RUNNER-TEST-2", ...source },
        email: { value: "runner.tester@example.test", factId: "RUNNER-TEST-3", ...source },
      } }));
      const resume = new TextEncoder().encode("%PDF-1.4\n% synthetic runner-test resume\n%%EOF\n");
      await Deno.writeFile(resumePath, resume);
      await Deno.mkdir(`${work}/evidence`, { mode: 0o700 });
      const engine = cloudEngineRunner({ root: ROOT, evidenceRoot: `${work}/evidence` });

      // The engine's dry run on the employer's page: the application the person approves. Nothing is sent.
      const p: any = await prepare({ url: `${site.base}/plain`, factsPath, resumePath, account: { epoch: 1, version: 1 }, now: Date.now(), runEngine: engine });
      assert(p.ready, `not prepared: ${JSON.stringify((p as any).result)}`);
      eq(site.posts(), 0, "a dry run sends nothing");

      // Setup, named: the approved application as the cloud claim leaves it (driving, source cloud, its own lease) and its
      // approved resume where the cloud keeps it. The claim itself refuses any host but a portal family's (part 2 and
      // tests/db/career_apply_cloud_runner.test.sql), so a page on 127.0.0.1 is put in its claimed state directly.
      // The resume first: the owner's resume rule (20261026210016) lets a row into driving only with its resume stored.
      await pg.sql(`insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
        values ('${P1}', '${p.payload.resume_sha256}', 'resume.pdf', decode('${btoa(String.fromCharCode(...resume))}', 'base64'), 1)`);
      const q = (s: string) => `$q$${s}$q$`;
      const claimed = JSON.parse(await pg.sql(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash,
        state, attempts, claimed_at, lease_token, source) select '${P1}', ${q(p.payload.job_id)}, ${q(p.payload.company)}, ${q(p.payload.url)}, x.p,
        public.career_apply_payload_hash(x.p), public.career_apply_payload_hash(x.p), 'driving', 1, now(), gen_random_uuid(), 'cloud'
        from (select ${q(JSON.stringify(p.payload))}::jsonb p) x returning json_build_object('id', id, 'lease', lease_token)`).then((s) => s.split("\n").at(-1)!));

      const rpc = pgRpc(pg), readJob = pgReadJob(pg), stopped: string[] = [];
      const deps = { rpc, readJob, secret: SECRET, stop: async (s: string) => { stopped.push(s); } };
      const sandbox = "sbx_TESTREAL";
      const token = await jobToken(SECRET, claimed.id, claimed.lease, sandbox);
      const bridge = bridgeQueue({ url: "https://bridge.test", id: claimed.id, sandbox, token, fetch: bridgeFetch(deps) });
      const phases: string[] = [];
      const done = await runSandboxJob({ bridge, runEngine: engine, tmpRoot: work, log: () => {},
        // A named stand-in for the live authorization's source functions (the draft bridge is not installed here).
        queue: (qq) => ({ ...qq, authorize: async (_j, phase) => { phases.push(phase); } }) });
      // The engine read the page's confirmation; the database records it as sent, awaiting the employer's email.
      eq([done.state, done.outcome, done.recorded], ["confirmed", "submitted", true], JSON.stringify(done));
      eq(phases, ["before_engine", "before_engine", "before_effect"], "authorized before the engine and again before the one Submit");
      eq(site.posts(), 1, "exactly one POST reached the employer's page");
      eq(site.upload(), p.payload.resume_sha256, "the approved resume, byte for byte");
      const row = JSON.parse(await pg.sql(`select row_to_json(j) from (select state, confirmation_id, evidence->>'by' by_, evidence->'answers' answers
        from public.career_apply_jobs where id = '${claimed.id}') j`));
      eq([row.state, row.by_], ["submitted_unconfirmed", "cloud"], "a page's thank-you is recorded, never as the employer's confirmation");
      assert(/RUNNER-1/.test(JSON.stringify(row)), "the page's confirmation number is kept");
      eq(row.answers.map((a: any) => a.value).sort(), ["Runner", "Tester", p.payload.resume_sha256, "runner.tester@example.test"].sort(),
        "the answers sent are the approved ones, and the resume by its hash");
      eq(stopped, [sandbox], "the bridge stops the sandbox at the finish");
      eq((await handleBridge("job", { id: claimed.id, sandbox, token }, deps)).status, 403, "after the finish the token opens nothing");
      eq([...Deno.readDirSync(work)].filter((e) => e.name.startsWith("trainee-cloud-")).length, 0, "the facts and resume written for the job are gone");
    } finally {
      await site.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
