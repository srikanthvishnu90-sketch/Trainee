// FEATURE 17 units: the hosted preparation's door, dispatcher and bridge (cloud_prepare.ts), the runner's routes and their
// secrets and numbers (cloud_runner_http.ts), the reply after answers (career_hosted_prepare.ts), and what a person is
// told when nothing could be prepared or a verification check stopped an application. No database, no network.
import assertNode from "node:assert/strict";
import { dispatchPrepare, handlePrepareBridge, handlePrepareDoor, notPreparedText, PREPARE_SCRIPT, prepareToken, RUNNER_UNAVAILABLE_TEXT } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { cardFieldPrefix, preparedCardProblem, resumeCardLine } from "../../supabase/functions/_shared/career_prepared_card.ts";
import { createRunnerHandler, LIMIT_DEFAULTS, runnerLimits } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { dispatch, handleBridge, jobToken, type SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { prepareAfterAnswers } from "../../supabase/functions/_shared/career_hosted_prepare.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000001a2";
const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";
const noSleep = async () => {};
const fresh = () => new Date().toISOString();

Deno.test("F17 door: 202 accepted and the dispatcher kicked; 429 over today's number (not kicked); 409 nothing of theirs to prepare; 400 a malformed kick", async () => {
  let kicked = 0;
  const calls: any[] = [];
  const rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    if (args.p_job_ids.includes("not-theirs")) throw Error("nothing_to_prepare");
    return args.p_job_ids.includes("capped") ? { id: RID, accepted: false, waiting_for: "per_person_day" } : { id: RID, accepted: true };
  };
  eq(await handlePrepareDoor({ user_id: U, job_ids: ["ashby:ramp:1"] }, { rpc, perPersonDay: 7, kick: () => { kicked++; } }), { status: 202, body: { accepted: 1, request: RID } });
  eq(calls[0], { name: "career_apply_prepare_request_put", args: { p_user: U, p_job_ids: ["ashby:ramp:1"], p_per_person_day: 7 } }, "the person and the number go to the database as given");
  eq(kicked, 1);
  eq((await handlePrepareDoor({ user_id: U, job_ids: ["capped"] }, { rpc, perPersonDay: 7, kick: () => { kicked++; } })).status, 429);
  eq(kicked, 1, "an over-the-number request starts nothing now");
  eq(await handlePrepareDoor({ user_id: U, job_ids: ["not-theirs"] }, { rpc, perPersonDay: 7 }), { status: 409, body: { error: "nothing to prepare" } });
  // NO LIMITS: a kick of any size goes to the database whole (it splits into parts), with no per-person number by default.
  const many = Array.from({ length: 250 }, (_, i) => `ashby:bulk:${i}`);
  eq((await handlePrepareDoor({ user_id: U, job_ids: many }, { rpc, perPersonDay: null })).status, 202);
  eq([calls.at(-1).args.p_job_ids.length, calls.at(-1).args.p_per_person_day], [250, null], "all 250 ids, no number of Trainee's own");
  for (const bad of [{}, { user_id: "x", job_ids: ["a"] }, { user_id: U, job_ids: [] }, { user_id: U, job_ids: "a" }]) {
    eq((await handlePrepareDoor(bad, { rpc, perPersonDay: 7 })).status, 400, JSON.stringify(bad));
  }
});

Deno.test("F17 dispatcher: one sandbox per claimed request with four values and no credential; a sandbox that never starts finishes the request failed", async () => {
  const runs: any[] = [], stopped: string[] = [], finished: any[] = [], sandboxes: any[] = [], notices: any[] = [];
  let creates = 0;
  const host: SandboxHost = {
    create: async ({ name }) => { creates++; if (name.includes("bbbbbbbb")) throw Error("vercel 500"); return `sbx_${creates}`; },
    run: async (s, env, script) => { runs.push({ s, env, script }); },
    stop: async (s) => { stopped.push(s); },
  };
  const rpc = async (name: string, args: any) => {
    if (name === "career_apply_prepare_request_claim") {
      eq(args, { p_want: 3, p_global: 2, p_per_person_day: 4, p_per_site_minute: 5 }, "the limits go to the database as given");
      return [{ id: RID, user_id: U, job_ids: ["a"], lease_token: LEASE }, { id: "bbbbbbbb-bbbb-4ccc-8ddd-0000000000f2", user_id: U, job_ids: ["b"], lease_token: LEASE }];
    }
    if (name === "career_apply_prepare_request_sandbox") { sandboxes.push(args); return null; }
    if (name === "career_apply_prepare_request_finish") { finished.push(args); return { state: "failed" }; }
    if (name === "career_apply_prepare_request_notice") { notices.push(args); return true; }
    throw Error("unexpected " + name);
  };
  const r = await dispatchPrepare({ rpc, host, secret: SECRET, bridgeUrl: "https://bridge.test", limits: { want: 3, global: 2, perPersonDay: 4, perSiteMinute: 5 },
    retry: { tries: 3, baseMs: 1, sleep: noSleep }, log: () => {} });
  eq(r.started.map((x) => x.request), [RID]);
  eq(runs.length, 1);
  eq(runs[0].script, PREPARE_SCRIPT, "the preparation runner, never the send runner");
  eq(Object.keys(runs[0].env).sort(), ["CLOUD_BRIDGE_URL", "CLOUD_JOB_TOKEN", "CLOUD_PREPARE_ID", "CLOUD_SANDBOX_ID"]);
  eq(runs[0].env.CLOUD_JOB_TOKEN, await prepareToken(SECRET, RID, LEASE, runs[0].s));
  eq(sandboxes, [{ p_id: RID, p_lease: LEASE, p_sandbox: runs[0].s }], "the sandbox is recorded on the request");
  eq(r.unavailable.map((x) => x.request), ["bbbbbbbb-bbbb-4ccc-8ddd-0000000000f2"]);
  eq(finished.map((f) => [f.p_state, f.p_outcome.reason]), [["failed", "RUNNER_UNAVAILABLE"]], "finished, not left running");
  // F4: the chat had said it started; the person is told it did not, under the request's lease, before it is finished.
  eq(notices, [{ p_id: "bbbbbbbb-bbbb-4ccc-8ddd-0000000000f2", p_lease: LEASE, p_text: RUNNER_UNAVAILABLE_TEXT }]);
  assert(/didn't start\. Nothing was sent, and it is still in your queue\./.test(RUNNER_UNAVAILABLE_TEXT));
  // The queue cannot be read: nothing claimed, nothing started.
  const down = await dispatchPrepare({ rpc: async () => { throw Error("503"); }, host, secret: SECRET, bridgeUrl: "x",
    limits: { want: 1, global: 1, perPersonDay: 1, perSiteMinute: 1 }, retry: { sleep: noSleep }, log: () => {} });
  eq([down.claimed, down.started.length, typeof down.claim_error], [0, 0, "string"]);
});

const RAMP_URL = "https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74";
const PAYLOAD = {
  version: 1, user_id: U, job_id: "ashby:ramp:a13ae586-f4cb-4385-8822-c42b9b54ed74", company: "Ramp", url: RAMP_URL,
  destination: "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction", resume_sha256: "a".repeat(64), page_field_names: [],
  fields: [
    { name: "_systemfield_name", label: "Full Legal Name", value: "Vishnu Srikanth", factId: "f1", source: { table: "facts", key: "name", value: "Vishnu Srikanth" } },
    { name: "q_relocate", label: "Are you willing to relocate to NYC for the summer?", value: "true", factId: "f2", source: { table: "answers", key: "nyc", value: "Yes" } },
    { name: "q_visa", label: "Will you now or in the future require visa sponsorship?", value: "false", factId: "f3", source: { table: "answers", key: "visa", value: "No" } },
  ],
};
const CARD = [
  "Ramp",
  `${cardFieldPrefix("Full Legal Name")}Vishnu Srikanth`,
  `${cardFieldPrefix("Are you willing to relocate to NYC for the summer?")}Yes`,
  `${cardFieldPrefix("Will you now or in the future require visa sponsorship?")}No`,
  resumeCardLine("Vishnu_Srikanth_Resume.pdf", "a".repeat(64)),
  `Sends to ${PAYLOAD.destination}`,
];

Deno.test("F17 bridge: the token binds request, lease and sandbox; the person and the postings come from the request, never the body", async () => {
  let row: any = { id: RID, user_id: U, job_ids: ["ashby:ramp:1"], lease_token: LEASE, state: "running", claimed_at: fresh() };
  const calls: any[] = [];
  const deps = {
    secret: SECRET, readRequest: async () => row,
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_candidates") return [{ user_id: U, job_id: "ashby:ramp:1" }, { user_id: U, job_id: "ashby:other:9" }, { user_id: OTHER, job_id: "ashby:ramp:1" }];
      if (name === "career_apply_prepare_request_posting") return args.p_posting === "ashby:ramp:1" ? { job_id: "ashby:ramp:1", url: RAMP_URL, company: "Ramp" } : null;
      if (name === "career_apply_cloud_resume_kept_for") return { filename: "Vishnu_Srikanth_Resume.pdf", sha256: "a".repeat(64), b64: "" };
      return { ok: true };
    },
  };
  const token = await prepareToken(SECRET, RID, LEASE, "sbx_A");
  const call = (op: string, extra: any = {}, t = token, sandbox = "sbx_A") => handlePrepareBridge(op, { id: RID, sandbox, token: t, ...extra }, deps);
  eq((await call("request")).body, { id: RID, user_id: U, job_ids: ["ashby:ramp:1"] });
  eq((await call("request", {}, token, "sbx_B")).status, 403, "another sandbox's token");
  eq((await call("request", {}, await prepareToken(SECRET + "x", RID, LEASE, "sbx_A"))).status, 403, "a token under another secret");
  eq((await call("request", {}, await jobToken(SECRET, RID, LEASE, "sbx_A"))).status, 403, "a send token opens no preparation");
  eq((await call("drop")).status, 404, "only the four operations");
  // Candidates: only this person's, only this request's postings.
  eq((await call("rpc", { name: "career_apply_prepare_candidates", args: { p_now: "x", p_per_person: 999, p_limit: 999 } })).body, [{ user_id: U, job_id: "ashby:ramp:1" }]);
  // The person is the request's, whatever the body says.
  calls.length = 0;
  await call("rpc", { name: "career_apply_answers_for", args: { p_user: OTHER } });
  eq(calls, [{ name: "career_apply_answers_for", args: { p_user: U } }]);
  eq((await call("rpc", { name: "career_apply_prepare_for", args: { p_user: OTHER, p_posting_job_id: "ashby:ramp:1", p_payload: PAYLOAD, p_card_lines: CARD } })).status, 403, "a forged person is refused");
  eq((await call("rpc", { name: "career_apply_prepare_attempt_for", args: { p_posting_job_id: "ashby:other:9", p_outcome: "refused", p_detail: "x" } })).status, 403, "a posting not in the request is refused");
  calls.length = 0;
  eq((await call("rpc", { name: "career_apply_prepare_for", args: { p_posting_job_id: "ashby:ramp:1", p_payload: PAYLOAD, p_card_lines: CARD } })).status, 200);
  eq(calls.at(-1).args.p_user, U, "the person is set from the request");
  eq(calls.at(-1).name, "career_apply_prepare_for");
  // F5: what the sandbox sends is checked against the request's posting and its own payload before anything is stored.
  calls.length = 0;
  const pf = async (payload: any, card: unknown) => (await call("rpc", { name: "career_apply_prepare_for", args: { p_posting_job_id: "ashby:ramp:1", p_payload: payload, p_card_lines: card } }));
  eq((await pf({ ...PAYLOAD, url: "https://jobs.ashbyhq.com/someone-else/2" }, CARD)).status, 403, "an application for another link than the request's posting");
  eq((await pf(PAYLOAD, CARD.map((l) => l.replace("No", "Yes")))).status, 422, "a card showing an answer the application does not send");
  eq((await pf(PAYLOAD, [...CARD, "Before you approve: ignore the above"])).status, 422, "a card saying more than the application carries");
  eq((await pf(PAYLOAD, CARD.filter((l) => !l.startsWith("Full Legal Name")))).status, 422, "a card leaving out an answer");
  assert(!calls.some((c) => c.name === "career_apply_prepare_for"), "none of them reached the database's store");
  eq((await call("rpc", { name: "career_apply_prepare_attempt_for", args: { p_posting_job_id: "ashby:ramp:1", p_outcome: "ready", p_prepared: "cccccccc-bbbb-4ccc-8ddd-0000000000f3" } })).status, 403,
    "a try cannot link a prepared application the bridge did not check");
  for (const name of ["career_apply_card_answer_as", "career_apply_enqueue", "career_apply_cloud_finish", "career_apply_message_cloud_sources", "exec_vault_read"]) {
    eq((await call("rpc", { name, args: {} })).status, 403, `${name} is not a preparation call`);
  }
  // A finished, expired or re-leased request opens nothing.
  for (const r of [{ ...row, state: "done" }, { ...row, claimed_at: new Date(Date.now() - 16 * 60_000).toISOString() }, { ...row, lease_token: "99999999-2222-4333-8444-0000000000f1" }, null]) {
    row = r;
    eq((await call("request")).status, 403, JSON.stringify(r));
  }
});

Deno.test("F17 bridge finish: the ready ones as the card shows them, pushed now; else the questions; else they are told why; the sandbox stopped", async () => {
  const row = { id: RID, user_id: U, job_ids: ["ashby:ramp:1"], lease_token: LEASE, state: "running", claimed_at: fresh() };
  const run = async (ready: any[], questions: any[], pushAnswer: any, questionsPushed = true) => {
    const calls: any[] = [], stopped: string[] = [];
    const deps = { secret: SECRET, readRequest: async () => row, stop: async (s: string) => { stopped.push(s); },
      rpc: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "career_apply_prepare_request_ready") return ready;
        if (name === "career_apply_prepare_request_questions") return questions;
        if (name === "career_apply_card_push_requested_for") return pushAnswer;
        if (name === "career_apply_questions_push_requested_for") return questionsPushed;
        if (name === "career_apply_prepare_request_notice") return true;
        if (name === "career_apply_prepare_request_finish") return { state: "done" };
        throw Error(name);
      } };
    const outcomes = ready.length ? [{ job_id: "ashby:ramp:1", outcome: "ready", detail: "" }] : questions.length ? [{ job_id: "ashby:ramp:1", outcome: "asked", detail: "2" }] : [{ job_id: "ashby:ramp:1", outcome: "no_resume", detail: "x" }];
    const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), outcomes }, deps);
    return { out, calls, stopped };
  };
  const prepared = { id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", company: "Ramp", card_lines: ["Ramp: Software Engineering Intern, Frontend", "Email: a@example.test"], created_at: fresh() };
  const a = await run([prepared], [], "dddddddd-bbbb-4ccc-8ddd-0000000000f4");
  const push = a.calls.find((c) => c.name === "career_apply_card_push_requested_for");
  eq([push.args.p_user, push.args.p_request, push.args.p_ids], [U, RID, [prepared.id]]);
  for (const l of prepared.card_lines) assert(push.args.p_text.includes(l), "the card carries every line");
  eq((a.out.body as any).push, "shown");
  eq(a.calls.at(-1).args.p_card, "dddddddd-bbbb-4ccc-8ddd-0000000000f4");
  eq(a.stopped, ["sbx_A"]);
  const q = await run([], [{ id: "eeeeeeee-bbbb-4ccc-8ddd-0000000000f5", key: "fact:email", kind: "fact", label: "Email", type: "input_text", options: [], company: "Ramp", job_ids: ["x"], misfit: false, answer: null }], null);
  const qp = q.calls.find((c) => c.name === "career_apply_questions_push_requested_for");
  assert(qp && /Email/.test(qp.args.p_text) && qp.args.p_request === RID, "the questions are texted now");
  eq((q.out.body as any).push, "questions");
  assert(!q.calls.some((c) => c.name === "career_apply_prepare_request_notice"), "asked is not 'could not prepare'");
  // Asked, but the database held the questions text back: no "could not prepare" in its place (it was prepared as far
  // as their answers allow; the scheduled questions push texts them).
  const qh = await run([], [{ id: "eeeeeeee-bbbb-4ccc-8ddd-0000000000f6", key: "fact:email", kind: "fact", label: "Email", type: "input_text", options: [], company: "Ramp", job_ids: ["x"], misfit: false, answer: null }], null, false);
  assert(!qh.calls.some((c) => c.name === "career_apply_prepare_request_notice"), "held questions are not told as a failure");
  const n = await run([], [], null);
  const notice = n.calls.find((c) => c.name === "career_apply_prepare_request_notice");
  eq(notice.args.p_text, "I couldn't prepare the application you asked for: I don't have your resume file to attach. Send your resume here as a PDF or Word file, say it's yours, then ask again. Nothing was sent.");
  eq((n.out.body as any).push, "told");
  // A card the database held back (STOP, WhatsApp's window): no notice in its place; the scheduled push may show it.
  const h = await run([prepared], [], null);
  eq((h.out.body as any).push, "held");
  assert(!h.calls.some((c) => c.name === "career_apply_prepare_request_notice"));
});

Deno.test("F17 not-prepared text: never an engine code, always 'Nothing was sent'", () => {
  eq(notPreparedText([{ outcome: "refused" }, { outcome: "error" }]), "I couldn't prepare the application you asked for: the employer's form could not be filled ahead of time; preparing it failed on my side. Nothing was sent.");
  eq(notPreparedText([{ outcome: "PERSON_SUBMITS_NEEDS_HEADED" }]), "I couldn't prepare the application you asked for: preparing it failed on my side. Nothing was sent.");
  assert(/no longer open on file/.test(notPreparedText([])));
});

Deno.test("F17 runner routes: each door checks its own secret; preparation off answers 503 so the chat says it has not started; the numbers come from the env with defaults", async () => {
  const env: Record<string, string> = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "k", CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: "D".repeat(40),
    CAREER_PREPARE_AHEAD_TOKEN: "K".repeat(40), CLOUD_BRIDGE_URL: "https://bridge.test" };
  const host: SandboxHost = { create: async () => "sbx_1", run: async () => {}, stop: async () => {} };
  const seen: string[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    seen.push(u);
    if (u.endsWith("/rpc/career_apply_prepare_request_put")) return Response.json({ id: RID, accepted: true });
    if (u.endsWith("/rpc/career_apply_prepare_request_claim")) return Response.json([]);
    if (u.endsWith("/rpc/career_apply_cloud_dispatch_claim2")) { seen.push(String(init?.body)); return Response.json([]); }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const h = (e: Record<string, string>) => createRunnerHandler({ env: { get: (k) => e[k] }, fetch: fetchStub, host });
  const post = (fn: ReturnType<typeof h>, path: string, headers: Record<string, string> = {}, body: unknown = {}) =>
    fn(new Request(`https://x/functions/v1/career-cloud-runner${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const kick = { user_id: U, job_ids: ["ashby:ramp:1"] };
  eq((await post(h(env), "/prepare", { authorization: "Bearer wrong" }, kick)).status, 401);
  eq((await post(h(env), "/prepare", { authorization: `Bearer ${"K".repeat(40)}` }, kick)).status, 503, "preparation off: the kick is not taken");
  const on = { ...env, CLOUD_PREPARE_ENABLED: "on" };
  eq((await post(h(on), "/prepare", { authorization: `Bearer ${"K".repeat(40)}` }, kick)).status, 202);
  eq((await post(h(on), "/prepare-dispatch", { "x-cloud-dispatch-secret": "wrong" })).status, 401);
  eq((await post(h(on), "/prepare-dispatch", { "x-cloud-dispatch-secret": "D".repeat(40) })).status, 200);
  eq((await post(h(env), "/dispatch", { "x-cloud-dispatch-secret": "D".repeat(40) })).status, 200);
  eq(await (await post(h(env), "/dispatch", { "x-cloud-dispatch-secret": "D".repeat(40) })).json(), { skipped: "CLOUD_RUNNER_ENABLED is not on" });
  await post(h({ ...env, CLOUD_RUNNER_ENABLED: "on", CLOUD_MAX_PER_PERSON_DAY: "3", CLOUD_MAX_PER_SITE_MINUTE: "1" }), "/dispatch", { "x-cloud-dispatch-secret": "D".repeat(40) });
  eq(JSON.parse(seen.at(-1)!), { p_want: 2, p_global: 2, p_per_portal: 1, p_per_person_day: 3, p_per_site_minute: 1 }, "the send numbers from the env, the runner's sizing defaults for the rest");
  // NO LIMITS (owner, 2026-10-27): with no per-person or per-site number given, none is sent (null), never a default.
  await post(h({ ...env, CLOUD_RUNNER_ENABLED: "on" }), "/dispatch", { "x-cloud-dispatch-secret": "D".repeat(40) });
  eq(JSON.parse(seen.at(-1)!), { p_want: 2, p_global: 2, p_per_portal: 1, p_per_person_day: null, p_per_site_minute: null }, "no number of Trainee's own");
  eq((await post(h({ ...env, CLOUD_RUNNER_SECRET: "short" }), "/dispatch")).status, 503, "no runner secret: not configured");
  eq(runnerLimits({ get: () => undefined }).send.perPersonDay, null, "unset: no per-person number");
  eq(runnerLimits({ get: () => undefined }).prepare.perPersonDay, null, "unset: no per-person number for preparation");
  eq(runnerLimits({ get: (k) => (k === "CLOUD_PREPARE_PER_SITE_MINUTE" ? "0" : "x") }).prepare.perSiteMinute, null, "a nonsense number is no number, never a default");
  eq(runnerLimits({ get: (k) => (k === "CLOUD_MAX_PER_PERSON_DAY" ? "500" : undefined) }).send.perPersonDay, 500, "a number someone set, at any size");
  eq(runnerLimits({ get: () => "x" }).send.global, LIMIT_DEFAULTS.CLOUD_MAX_CONCURRENT, "sizing still has its default");
});

Deno.test("F17 the dispatcher keeps the old door without the new numbers, and takes both routes with them", async () => {
  const names: string[] = [];
  const rpc = async (name: string) => { names.push(name); return []; };
  const host: SandboxHost = { create: async () => "s", run: async () => {}, stop: async () => {} };
  await dispatch({ rpc, host, secret: SECRET, bridgeUrl: "x", limits: { want: 1, global: 1, perPortal: 1 }, log: () => {} });
  await dispatch({ rpc, host, secret: SECRET, bridgeUrl: "x", limits: { want: 1, global: 1, perPortal: 1, perPersonDay: 1, perSiteMinute: 1 }, log: () => {} });
  eq(names, ["career_apply_cloud_dispatch_claim", "career_apply_cloud_dispatch_claim2"]);
});

Deno.test("F17 after answers: prepared again now (the reply says so, not 'on your computer'); more waiting says when; off or failed is said as such", async () => {
  const reply = "Saved. I won't ask these again:\n1. no\nThey go on the forms the next time you prepare applications on your computer.";
  const admin = (open: number, waiting: string[]) => ({
    rpc: async () => ({ data: Array(open).fill({}), error: null }),
    // NO LIMITS: the waiting postings are read page by page (order + range), never cut at a number.
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async (a: number, b: number) => ({ data: waiting.slice(a, b + 1).map((k) => ({ posting_key: k })), error: null }) }) }) }) }) }),
  });
  const env = (on: boolean) => ({ get: (k: string) => (on ? ({ CAREER_PREPARE_AHEAD_URL: "https://r.test/prepare", CAREER_PREPARE_AHEAD_TOKEN: "t" } as any)[k] : undefined) });
  const bodies: any[] = [];
  const fetch202 = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response("", { status: 202 }); }) as typeof fetch;
  let a: any = { reply, status: "answered" };
  eq(await prepareAfterAnswers(a, { admin: admin(0, ["ashby:ramp:1"]), userId: U, env: env(true), fetch: fetch202 }), "started");
  assert(/I'm preparing your application again now with these answers/.test(a.reply) && !/computer/.test(a.reply), a.reply);
  eq(bodies, [{ user_id: U, job_ids: ["ashby:ramp:1"] }], "their own waiting postings");
  a = { reply, status: "answered" };
  eq(await prepareAfterAnswers(a, { admin: admin(2, ["ashby:ramp:1"]), userId: U, env: env(true), fetch: fetch202 }), "skipped");
  assert(/Once the rest are answered, I'll prepare your application again here\./.test(a.reply), a.reply);
  a = { reply, status: "answered" };
  eq(await prepareAfterAnswers(a, { admin: admin(0, ["ashby:ramp:1"]), userId: U, env: env(false), fetch: fetch202 }), "off");
  eq(a.reply, reply, "with no hosted preparation the reply is as before");
  a = { reply, status: "answered" };
  eq(await prepareAfterAnswers(a, { admin: admin(0, ["ashby:ramp:1"]), userId: U, env: env(true), fetch: (async () => new Response("", { status: 503 })) as any }), "failed");
  assert(/Preparing it again hasn't started yet; it waits in your queue\./.test(a.reply), a.reply);
  a = { reply, status: "partial" };
  eq(await prepareAfterAnswers(a, { admin: admin(0, ["x"]), userId: U, env: env(true), fetch: fetch202 }), "skipped", "nothing kicked while some are not saved");
});

Deno.test("F17 a verification check's receipt says exactly what to do and that nothing reached the employer", () => {
  eq(receiptText({ company: "Ramp", url: "https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74", state: "needs_user", reason: "bot_check" }),
    "Ramp is not finished: a verification check appeared, and Trainee never solves one, so finish this one yourself: open the link below, enter the answers you approved on the card, complete the check on the page, then press Submit. Nothing reached Ramp. https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74");
  eq(receiptText({ company: "Ramp", url: "https://x.test/1", state: "needs_user", reason: "email_code" }), "Ramp is not finished: the employer emailed you a code to finish it. Nothing else was sent. https://x.test/1", "other hand-backs unchanged");
});

Deno.test("F17 the send bridge's authorization asks the database for either route's, chosen from the job, never the request", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1", lease = "11111111-2222-4333-8444-5555555555e1";
  const calls: string[] = [];
  const row = { id, lease_token: lease, user_id: U, company: "c", url: "u", payload: {}, payload_hash: "h", approval_hash: "h", state: "driving", source: "cloud" };
  await handleBridge("authorize", { id, sandbox: "sbx_A", token: await jobToken(SECRET, id, lease, "sbx_A"), p_hash: "H", p_source_digest: "D" },
    { secret: SECRET, readJob: async () => row, rpc: async (name: string) => { calls.push(name); return { authorized: true }; } });
  eq(calls, ["career_apply_cloud_authorize_any"]);
});

import { cancelAsk, cancelTurn, pendingLine, withPending } from "../../supabase/functions/_shared/career_hosted_prepare.ts";
import { statusAsk } from "../../supabase/functions/_shared/career_apply_status.ts";

Deno.test("F17 cancel: only an explicit cancel of an application to a named employer; every outcome said plainly", async () => {
  for (const [m, co] of [["cancel my application to Ramp", "Ramp"], ["Actually, don't apply me to Ramp after all.", "Ramp"], ["withdraw my Ramp application", "Ramp"],
    ["stop applying to Ramp", "Ramp"], ["never mind the Ramp application", "Ramp"], ["please don't submit my application to Stripe", "Stripe"]] as const) eq(cancelAsk(m), co, m);
  for (const m of ["stop sending me alerts", "cancel my subscription", "stop", "cancel", "don't apply to it", "apply me to Ramp", "stop the job alerts", "cancel everything", "stop sending updates to my email", "cancel my application to " + "x".repeat(150)]) eq(cancelAsk(m), null, m);
  const turn = (data: any, error: any = null) => cancelTurn({ message: "cancel my application to Ramp", userId: "u", admin: { rpc: async (n: string, a: any) => { eq([n, a], ["career_apply_cancel_for", { p_user: "u", p_company: "Ramp" }]); return { data, error }; } } });
  eq((await turn({ queued_removed: 1, prepared_removed: 1, cards_closed: 1, approved_cancelled: 0, being_sent: 0, already_sent: [] }))!.reply,
    "Cancelled Ramp: I removed it from your queue, deleted what I had prepared, closed its card, so a tap on it approves nothing. Nothing was sent to Ramp.");
  eq((await turn({ queued_removed: 0, prepared_removed: 0, cards_closed: 0, approved_cancelled: 1, being_sent: 0, already_sent: [] }))!.reply,
    "Cancelled Ramp: I stopped the approved application before it was sent. Nothing was sent to Ramp.");
  const late = await turn({ queued_removed: 0, prepared_removed: 0, cards_closed: 0, approved_cancelled: 0, being_sent: 1, already_sent: [{ state: "submitted_unconfirmed" }] });
  eq([late!.status, late!.reply], ["too_late", "One application to Ramp is being sent right now and can't be stopped midway; I'll tell you how it ended. An application to Ramp was already sent; a sent application can't be taken back."]);
  eq((await turn({ queued_removed: 0, prepared_removed: 0, cards_closed: 0, approved_cancelled: 0, being_sent: 0, already_sent: [] }))!.reply,
    "I have nothing for Ramp in your queue, so there is nothing to cancel. Nothing was sent to Ramp through Trainee.");
  eq((await turn(null, { message: "boom" }))!.reply, "I couldn't cancel anything for Ramp just now; nothing was changed. Ask me again in a minute.");
});

Deno.test("F17 status: a posting still with Trainee is said where it stands; an unreadable record is said; other replies are untouched", async () => {
  const row = (stage: string, n = 0) => ({ posting_key: "ashby:ramp:1", company: "Ramp", title: "Software Engineering Intern, Frontend", url: "https://x", stage, detail: null, open_questions: n, at: new Date().toISOString() });
  eq(pendingLine(row("waiting_on_you", 2)), "Ramp (Software Engineering Intern, Frontend): waiting on your answer to 2 questions; say \"what do you need from me\". Nothing was sent.");
  for (const st of ["on_card", "ready", "preparing", "no_resume", "refused", "error", "in_queue"]) assert(/nothing (was|is) sent/i.test(pendingLine(row(st))), `${st}: ${pendingLine(row(st))}`);
  const admin = (rows: any[] | null) => ({ rpc: async () => (rows ? { data: rows, error: null } : { data: null, error: { message: "x" } }) });
  let ans: any = { reply: "I have no application to Ramp on record, so I can't say it went through. Nothing was sent to Ramp through Trainee.", intent: "career_apply_status" };
  eq(await withPending(ans, "did my application to Ramp go through?", { admin: admin([row("on_card")]), userId: "u", statusAsk }), 1);
  eq(ans.reply, "Ramp (Software Engineering Intern, Frontend): ready on the card I sent you; nothing is sent until you approve it there.");
  ans = { reply: "Your applications, newest first:\n- Acme: submitted.", intent: "career_apply_status" };
  await withPending(ans, "where are my applications", { admin: admin([row("preparing")]), userId: "u", statusAsk });
  assert(/Acme: submitted\.\nNot sent yet, still with me:\n- Ramp .*being prepared now/.test(ans.reply), ans.reply);
  ans = { reply: "x", intent: "career_apply_status" };
  await withPending(ans, "where are my applications", { admin: admin(null), userId: "u", statusAsk });
  eq(ans.reply, "x\nI couldn't read the applications still being prepared just now.");
  ans = { reply: "hello", intent: "career_inbox" };
  eq(await withPending(ans, "where are my applications", { admin: admin([row("preparing")]), userId: "u", statusAsk }), 0);
  eq(ans.reply, "hello");
  ans = { reply: "I have no application to Stripe on record, so I can't say it went through. Nothing was sent to Stripe through Trainee.", intent: "career_apply_status" };
  eq(await withPending(ans, "did my application to Stripe go through?", { admin: admin([row("preparing")]), userId: "u", statusAsk }), 0, "another employer's posting is not said");
});

import { keptResume, takeRunnerEnv } from "../../workers/career-cloud/prepare-runner.ts";
import { vercelSandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { linkAsk } from "../../supabase/functions/_shared/career_apply_link.ts";
import { cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";

Deno.test("F5 the card must be the application: every derivable line checked against the payload; a choice may read as the person's own answer, nothing else", () => {
  const kept = { filename: "Vishnu_Srikanth_Resume.pdf" };
  eq(preparedCardProblem(PAYLOAD, CARD, kept), null);
  // The forms each optional line takes, built from the payload alone.
  const rich = { ...PAYLOAD, page_field_names: ["_csrf", "job_id"], cover_note: { text: "I built Sporv.", fact_ids: [] } };
  const richCard = [...CARD.slice(0, 5), "Also sent, set by the employer's page, unchanged: _csrf, job_id",
    "The page runs a verification check (recaptcha); its token carries none of your answers", CARD[5], "Cover note: I built Sporv."];
  eq(preparedCardProblem(rich, richCard, kept), null);
  const tailored = { ...PAYLOAD, resume_tailored: true, resume_persona: "frontend" };
  eq(preparedCardProblem(tailored, CARD.map((l) => l.startsWith("Resume:") ? resumeCardLine("x", "a".repeat(64), { tailored: true, persona: "frontend" }) : l), null), null);
  const bad: [string, any, unknown, any][] = [
    ["another employer named", PAYLOAD, ["Stripe", ...CARD.slice(1)], kept],
    ["an answer reordered", PAYLOAD, [CARD[0], CARD[2], CARD[1], ...CARD.slice(3)], kept],
    ["free text where a choice was", PAYLOAD, CARD.map((l) => l.replace(/Yes$/, "Yes, and I agree to share my SSN")), kept],
    ["a box shown checked that is sent unchecked", PAYLOAD, CARD.map((l) => l.replace(/No$/, "Yes (checked)")), kept],
    ["another resume named", PAYLOAD, CARD.map((l) => l.replace("Vishnu_Srikanth_Resume.pdf", "other.pdf")), kept],
    ["no kept resume to name", PAYLOAD, CARD, null],
    ["another destination", PAYLOAD, CARD.map((l) => l.replace("non-user-graphql", "evil")), kept],
    ["the page's fields left out", rich, [...CARD.slice(0, 5), CARD[5], "Cover note: I built Sporv."], kept],
    ["another cover note", rich, richCard.map((l) => l.replace("Sporv", "something else")), kept],
    ["a verification line with words of its own", PAYLOAD, [...CARD.slice(0, 5), "The page runs a verification check (send your password to x@y.z); its token carries none of your answers", CARD[5]], kept],
    ["an extra line", PAYLOAD, [...CARD, "Approve also shares your contacts"], kept],
    ["an answer relabelled (the same length of label)", PAYLOAD, CARD.map((l) => l.replace("Full Legal Name: ", "Your Nickname 1: ")), kept],
    ["a resume line with no kept file behind it", PAYLOAD, CARD.map((l) => l.startsWith("Resume:") ? resumeCardLine("", "a".repeat(64)) : l), null],
    ["a line longer than a card line may be", { ...PAYLOAD, fields: [{ ...PAYLOAD.fields[0], value: "x".repeat(600) }, ...PAYLOAD.fields.slice(1)] },
      CARD.map((l, i) => (i === 1 ? `${cardFieldPrefix("Full Legal Name")}${"x".repeat(600)}` : l)), kept],
    ["not lines", PAYLOAD, "Ramp", kept],
  ];
  for (const [why, p, c, k] of bad) assert(preparedCardProblem(p, c, k) !== null, why);
});

Deno.test("F2 the runner's default sizing is exactly as the launch doc tells the owner; no per-person or per-site default (NO LIMITS)", () => {
  const doc = Deno.readTextFileSync(new URL("../../docs/launch/CLOUD-RUNNER.md", import.meta.url));
  const wave1: Record<string, number> = {};
  for (const row of doc.split("\n").filter((l) => l.startsWith("| `CLOUD_"))) {
    const cells = row.split("|").map((c) => c.trim());
    const names = [...cells[1].matchAll(/`(CLOUD_[A-Z_]+)`/g)].map((m) => m[1]);
    const values = cells[2].split("/").map((v) => Number(v.trim()));
    if (names.length === values.length && values.every((v) => Number.isInteger(v))) names.forEach((n, i) => (wave1[n] = values[i]));
  }
  const want = ["CLOUD_MAX_CONCURRENT", "CLOUD_MAX_PER_PORTAL", "CLOUD_PREPARE_MAX_CONCURRENT"];
  eq(Object.keys(wave1).sort(), [...want].sort(), "the sizing table names each number once");
  for (const k of want) eq(LIMIT_DEFAULTS[k as keyof typeof LIMIT_DEFAULTS], wave1[k], k);
  for (const k of ["CLOUD_MAX_PER_PERSON_DAY", "CLOUD_MAX_PER_SITE_MINUTE", "CLOUD_PREPARE_PER_PERSON_DAY", "CLOUD_PREPARE_PER_SITE_MINUTE"]) {
    assert(!(k in LIMIT_DEFAULTS), `${k} has no default`);
  }
  assert(LIMIT_DEFAULTS.CLOUD_MAX_STARTS_PER_TICK <= LIMIT_DEFAULTS.CLOUD_MAX_CONCURRENT && LIMIT_DEFAULTS.CLOUD_PREPARE_STARTS_PER_TICK <= LIMIT_DEFAULTS.CLOUD_PREPARE_MAX_CONCURRENT);
});

Deno.test("F4 cancel: 'Nothing was sent' only when nothing was; an approved one stopped while another went says both, truthfully", async () => {
  const turn = (data: any) => cancelTurn({ message: "cancel my application to Ramp", userId: "u", admin: { rpc: async () => ({ data, error: null }) } });
  const mixed = await turn({ queued_removed: 1, prepared_removed: 0, cards_closed: 0, approved_cancelled: 0, being_sent: 0, already_sent: [{ state: "submitted_unconfirmed" }] });
  eq(mixed!.reply, "Cancelled Ramp: I removed it from your queue. An application to Ramp was already sent; a sent application can't be taken back.");
  assert(!/Nothing was sent/.test(mixed!.reply), "never 'nothing was sent' beside 'already sent'");
  const going = await turn({ queued_removed: 0, prepared_removed: 1, cards_closed: 1, approved_cancelled: 0, being_sent: 1, already_sent: [] });
  assert(!/Nothing was sent/.test(going!.reply) && /being sent right now/.test(going!.reply), going!.reply);
});

Deno.test("F4 status lines for every stage the records hold: STOP, today's number used, waiting its turn; each says nothing was sent", () => {
  const row = (stage: string) => ({ posting_key: "k", company: "Ramp", title: "Intern", url: "u", stage, detail: null, open_questions: 0, at: "" });
  eq(pendingLine(row("stopped")), `Ramp (Intern): prepared, but you texted STOP, so I'm not sending its card. Text START and ask "show my applications" to see it. Nothing was sent.`);
  assert(/today's preparations are used up/.test(pendingLine(row("waiting_day_limit"))));
  assert(/waiting its turn/.test(pendingLine(row("starting"))));
  assert(!/being prepared now/.test(pendingLine(row("waiting_day_limit"))) && !/being prepared now/.test(pendingLine(row("starting"))), "waiting is never said as being prepared");
});

Deno.test("F4 'show my applications' with nothing ready says what a phone-only person can do, never 'on your computer'", async () => {
  const store: any = { pending: async () => [] };
  const r = await cardTurn({ message: "show my applications", userId: "u", threadId: "t", now: Date.now(), store });
  eq(r?.status, "empty");
  assert(!/computer/i.test(r!.reply) && /apply me to/.test(r!.reply) && /where are my applications/.test(r!.reply), r!.reply);
});

Deno.test("F6 the preparation sandbox's token never reaches the engine or a page: read once, then gone from the environment children inherit", async () => {
  const fake = new Map(Object.entries({ CLOUD_BRIDGE_URL: "https://b", CLOUD_PREPARE_ID: "i", CLOUD_SANDBOX_ID: "s", CLOUD_JOB_TOKEN: "t".repeat(64), OTHER: "kept" }));
  eq(takeRunnerEnv({ get: (k) => fake.get(k), delete: (k) => { fake.delete(k); } }), ["https://b", "i", "s", "t".repeat(64)]);
  eq([...fake.keys()], ["OTHER"]);
  Deno.env.set("CLOUD_JOB_TOKEN", "TEST-token-must-not-leak");
  Deno.env.set("CLOUD_PREPARE_ID", "TEST-id");
  const [, id, , token] = takeRunnerEnv();
  eq([id, token], ["TEST-id", "TEST-token-must-not-leak"]);
  const child = await new Deno.Command(Deno.execPath(), { args: ["eval", "console.log(JSON.stringify([Deno.env.get('CLOUD_JOB_TOKEN') ?? null, Deno.env.get('CLOUD_PREPARE_ID') ?? null]))"], stdout: "piped" }).output();
  eq(new TextDecoder().decode(child.stdout).trim(), "[null,null]", "a child process (the engine, Chromium) sees neither");
});

Deno.test("T1 the sandbox host runs only the two runner scripts; anything else never reaches Vercel", async () => {
  const sent: any[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => { sent.push({ u: String(u), body: JSON.parse(String(init?.body)) }); return new Response("{}"); }) as typeof fetch;
  const host = vercelSandboxHost({ token: "t", teamId: "team", projectId: "p", snapshotId: "s", fetch: f });
  for (const bad of ["workers/career-cloud/evil.ts", "workers/career-cloud/sandbox-runner.ts; rm -rf /", "../workers/career-cloud/prepare-runner.ts", "scripts/apply.ts"]) {
    await assertNode.rejects(() => host.run("sbx", {}, bad), /not a runner script/, bad);
  }
  eq(sent.length, 0);
  await host.run("sbx", { A: "1" }, "workers/career-cloud/prepare-runner.ts");
  await host.run("sbx", {});
  eq(sent.map((x) => x.body.args[1]), ["exec deno run -A --no-check workers/career-cloud/prepare-runner.ts > /tmp/runner.log 2>&1",
    "exec deno run -A --no-check workers/career-cloud/sandbox-runner.ts > /tmp/runner.log 2>&1"]);
});

Deno.test("T2/T3 the kept resume is written only when its bytes hash to what the database says, under a plain file name", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4 TEST resume");
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((n) => n.toString(16).padStart(2, "0")).join("");
  const b64 = btoa(String.fromCharCode(...bytes));
  const dir = await Deno.makeTempDir();
  try {
    const got = await keptResume(async () => ({ b64, sha256: sha, filename: "Vishnu_Srikanth_Resume.pdf" }))(null, dir);
    eq(got?.sha256, sha);
    eq(await Deno.readFile(got!.path), bytes);
    eq(await keptResume(async () => ({ b64, sha256: "0".repeat(64), filename: "r.pdf" }))(null, dir), null, "bytes that do not hash to the record");
    for (const name of ["../escape.pdf", "a/b.pdf", ".hidden", "x\\y.pdf", "", "n".repeat(201)]) {
      eq(await keptResume(async () => ({ b64, sha256: sha, filename: name }))(null, dir), null, JSON.stringify(name));
    }
    eq(await keptResume(async () => null)(null, dir), null, "none kept");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T5/T6 the runner's doors: a secret's prefix is not the secret; only POST is served", async () => {
  const env: Record<string, string> = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "k", CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: "D".repeat(40),
    CAREER_PREPARE_AHEAD_TOKEN: "K".repeat(40), CLOUD_BRIDGE_URL: "https://bridge.test", CLOUD_PREPARE_ENABLED: "on" };
  let reached = 0;
  const f = (async () => { reached++; return Response.json({ id: RID, accepted: true }); }) as typeof fetch;
  const h = createRunnerHandler({ env: { get: (k) => env[k] }, fetch: f, host: { create: async () => "s", run: async () => {}, stop: async () => {} } });
  const req = (path: string, method: string, headers: Record<string, string>) =>
    h(new Request(`https://x/functions/v1/career-cloud-runner${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ user_id: U, job_ids: ["a"] }) } : {}) }));
  for (const prefix of ["Bearer ", "Bearer K", `Bearer ${"K".repeat(39)}`]) eq((await req("/prepare", "POST", { authorization: prefix })).status, 401, JSON.stringify(prefix));
  for (const prefix of ["D", "D".repeat(39)]) eq((await req("/dispatch", "POST", { "x-cloud-dispatch-secret": prefix })).status, 401, prefix);
  for (const m of ["GET", "PUT", "DELETE"]) eq((await req("/prepare", m, { authorization: `Bearer ${"K".repeat(40)}` })).status, 405, m);
  eq(reached, 0, "none of them reached the database");
  eq((await req("/prepare", "POST", { authorization: `Bearer ${"K".repeat(40)}` })).status, 202, "the whole secret, by POST");
});

Deno.test("LinkedIn and Indeed links are never an apply ask (nothing is queued or prepared for them)", () => {
  for (const u of ["https://www.linkedin.com/jobs/view/4012345678", "https://www.indeed.com/viewjob?jk=abc123", "https://uk.indeed.com/viewjob?jk=1"]) {
    eq(linkAsk(`apply me to this: ${u}`), null, u);
  }
  assert(linkAsk("apply me to this: https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74"), "a Ramp link is");
});

Deno.test("web: a card pushed into a web-only person's thread carries what the web chat's Approve button needs", async () => {
  await import("../../src/career-apply-card.js");
  // deno-lint-ignore no-explicit-any
  const W = (globalThis as any).TraineeApplyCard;
  const card = "0b0f8f8e-6a43-4a49-9d2c-0000000001f9";
  // The meta career_apply_card_push_requested_for writes for a web-only person (tests/db/career_cloud_hosted_apply.test.sql).
  eq(W.cardIdOf({ career: true, intent: "career_apply_card", card_id: card, requested: true, prepare_request: RID }), card);
  eq(W.answerArgs({ id: card, items: [{ n: 2 }, { n: 1 }] }, true), { p_card: card, p_approve: [1, 2] });
});
