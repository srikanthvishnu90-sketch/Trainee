// WO-021 W1 + W4 (architect): approve first, then apply without asking twice. The engine is a fake here; the real
// engine runs in tests/career-approve-first.test.cjs. Contract: docs/architect/work-orders/WO-021-approve-first.md.
import {
  factsFromPayload,
  jwtRole,
  ownQueue,
  prepare,
  runApproved,
  runLoop,
} from "../../workers/career-browser/approve-first.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { normLabel } from "../../supabase/functions/_shared/career_apply.ts";
import { proofFor } from "./proof-fixture.ts";
// Job ids as the queue makes them (career_apply_jobs.id is a uuid).
const J1 = "00000000-0000-4000-8000-000000000001", J2 = "00000000-0000-4000-8000-000000000002", J_OTHER = "00000000-0000-4000-8000-000000000009";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const HASH = "a".repeat(64);
const evidence = {
  approval_hash: HASH,
  readback: { first_name: "TEST Ada", email: "test@example.test", q1: "Yes" },
  fields: [
    { name: "first_name", label: "First name", value: "TEST Ada", factId: "TEST-1" },
    { name: "email", label: "Email", value: "test@example.test", factId: "TEST-2" },
    { name: "q1", label: "Are you authorized to work in the US?", value: "Yes", factId: "TEST-3" },
  ],
  payload: {
    user_id: "TEST-USER",
    posting: "greenhouse:acme:1",
    company: "job-boards.greenhouse.io/acme",
    destination: "https://job-boards.greenhouse.io/acme/jobs/1",
    resume: { filename: "r.pdf", sha256: "b".repeat(64) },
    page_fields: { accountId: "x" },
  },
};
const dry = async () => ({ result: { state: "not_submitted", reason: "dry_run" }, evidence });

Deno.test("WO-021/1 a prepared application carries every answer on its card and the engine's approval in its payload", async () => {
  const r = await prepare({
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    factsPath: "f",
    resumePath: "r",
    account: { epoch: 3, version: 7 },
    now: Date.parse("2026-10-20T00:00:00Z"),
    runEngine: dry,
  });
  assert(r.ready);
  eq(r.payload.engine_approval, HASH);
  eq(r.payload.fields.length, 3);
  eq(r.payload.privacy_epoch, 3);
  eq(r.payload.expires_at, "2026-10-21T00:00:00.000Z");
  eq(r.hash, await hashApplyPayload(r.payload), "the queue's approval is the hash of exactly this payload");
  // architect amendment, D.4 6 source label (WO-122): the reused work-rights answer says where it came from
  for (const f of evidence.fields) {
    const from = f.name === "q1" ? " (from your confirmed facts)" : "";
    assert(r.card.some((l) => l === `${f.label}: ${f.value}${from}`), "card shows " + f.label);
  }
  eq(r.card.filter((l) => l.startsWith("Resume")).length, 1, "the resume appears once, by name");
  assert(
    r.card.some((l) => l.includes("set by the employer's page") && l.includes("accountId")),
    "the employer's own fields are on the card",
  );
  assert(r.card.some((l) => l.includes("job-boards.greenhouse.io/acme/jobs/1")), "card shows where it goes");
});

Deno.test("WO-021/2 a posting with open questions is not prepared", async () => {
  const r = await prepare({
    url: "u",
    factsPath: "f",
    resumePath: "r",
    account: { epoch: 0, version: 0 },
    now: 0,
    runEngine: async () => ({
      result: { state: "not_submitted", reason: "needs_answers", fields: ["Q"] },
      evidence: {},
    }),
  });
  eq(r.ready, false);
  eq(r.result.reason, "needs_answers");
});

Deno.test("WO-021/3 the approved answers become the engine's facts under each question, fact ids kept", () => {
  const f = factsFromPayload({ user_id: "TEST-USER", fields: evidence.fields });
  eq(f.saved[normLabel("Are you authorized to work in the US?")], { value: "Yes", factId: "TEST-3", confirmed: true });
  eq(Object.keys(f.answers).length, 0);
  let threw = false;
  try {
    factsFromPayload({
      user_id: "u",
      fields: [{ label: "Name", value: "A", factId: "1" }, { label: "Name", value: "B", factId: "2" }],
    });
  } catch {
    threw = true;
  }
  assert(threw, "two answers to the same question are refused, never one picked");
});

function harness(over: Partial<Parameters<typeof runApproved>[0]> = {}) {
  const finished: unknown[] = [], calls: string[][] = [];
  const job = {
    id: J1,
    lease_token: "L1",
    url: "https://x.test/1",
    payload: {
      ...evidence,
      ...{ user_id: "TEST-USER" },
      fields: evidence.fields,
      engine_approval: HASH,
      resume_sha256: "b".repeat(64),
    },
  };
  const deps = {
    claim: async () => [job],
    finish: async (id: string, lease: string, state: string, ev: Record<string, unknown>) => {
      finished.push({ id, lease, state, reason: ev.reason });
    },
    resumeFor: async () => ({ path: "/r.pdf", sha256: "b".repeat(64) }),
    writeFacts: async () => "/facts.json",
    runEngine: async (args: string[]) => {
      calls.push(args);
      return {
        result: { state: "confirmed", reason: "employer confirmation on the page", confirmation_id: "C-1", proof: proofFor(args) },
        evidence: {},
      };
    },
    ...over,
  };
  return { deps, finished, calls };
}

Deno.test("WO-021/4 the worker submits an approved application with --approved and records the employer's answer", async () => {
  const h = harness();
  await runApproved(h.deps);
  eq(h.calls.length, 1);
  const a = h.calls[0];
  assert(a.includes("--submit") && a[a.indexOf("--approved") + 1] === HASH, JSON.stringify(a));
  eq(h.finished, [{ id: J1, lease: "L1", state: "confirmed", reason: "employer confirmation on the page" }]);
});

Deno.test("WO-021/5 a different resume than the approved one stops before the engine runs: not submitted", async () => {
  const h = harness({ resumeFor: async () => ({ path: "/r.pdf", sha256: "c".repeat(64) }) });
  await runApproved(h.deps);
  eq(h.calls.length, 0);
  eq(h.finished, [{ id: J1, lease: "L1", state: "not_submitted", reason: "RESUME_CHANGED" }]);
});

Deno.test("WO-021/6 an engine that started and gave no result is unknown, never retried as not sent", async () => {
  const h = harness({ runEngine: async () => null });
  await runApproved(h.deps);
  eq((h.finished[0] as any).state, "unknown_outcome");
});

Deno.test("WO-021/7 an application that changed since the approval is passed through as not submitted", async () => {
  const h = harness({
    runEngine: async () => ({
      result: { state: "not_submitted", reason: "APPROVED_APPLICATION_CHANGED" },
      evidence: {},
    }),
  });
  await runApproved(h.deps);
  eq(h.finished, [{ id: J1, lease: "L1", state: "not_submitted", reason: "APPROVED_APPLICATION_CHANGED" }]);
});

// W4 on the person's own computer: the queue is the person's own (career_apply_claim_own / career_apply_finish_own).
function fakeClient(o: { claimFails?: number; finishFails?: number; jobs?: any[]; expired?: boolean } = {}) {
  const calls: { name: string; args: any }[] = [];
  let claimFails = o.claimFails ?? 0, finishFails = o.finishFails ?? 0;
  const jobs = [...(o.jobs ?? [])];
  return {
    calls,
    rpc: (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_claim_own") {
        if (o.expired) return Promise.resolve({ data: null, error: { code: "PGRST301", message: "JWT expired" } });
        if (claimFails-- > 0) return Promise.resolve({ data: null, error: { message: "down" } });
        return Promise.resolve({ data: jobs.splice(0, args.p_limit), error: null });
      }
      if (name === "career_apply_finish_own") {
        if (finishFails-- > 0) return Promise.resolve({ data: null, error: { message: "down" } });
        return Promise.resolve({ data: { id: args.p_id, state: args.p_state }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unexpected " + name } });
    },
  };
}
const queuedJob = (id: string) => ({
  id,
  lease_token: "L-" + id,
  url: "https://x.test/" + id,
  payload: { user_id: "TEST-USER", fields: evidence.fields, engine_approval: HASH, resume_sha256: "b".repeat(64) },
});
function loop(client: ReturnType<typeof fakeClient>, o: { rounds: number; engine?: any }) {
  let n = 0;
  const runs: string[][] = [], logs: string[] = [];
  return runLoop({
    queue: ownQueue(client),
    resume: { path: "/r.pdf", sha256: "b".repeat(64) },
    writeFacts: async () => "/facts.json",
    runEngine: o.engine ?? (async (args: string[]) => {
      runs.push(args);
      return { result: { state: "confirmed", reason: "employer confirmation on the page", proof: proofFor(args) }, evidence: {} };
    }),
    stop: () => n++ >= o.rounds,
    sleep: async () => {},
    log: (l) => logs.push(l),
  }).then((ran) => ({ ran, runs, logs }));
}

Deno.test("WO-021/8 the worker claims only through the person's own queue, one at a time, and records each outcome by its lease", async () => {
  const c = fakeClient({ jobs: [queuedJob(J1), queuedJob(J2)] });
  const r = await loop(c, { rounds: 3 });
  eq(r.ran.map((x) => [x.id, x.state, x.recorded]), [[J1, "confirmed", true], [J2, "confirmed", true]]);
  eq(r.runs.length, 2, "one engine run per claimed application");
  assert(
    c.calls.filter((x) => x.name === "career_apply_claim_own").every((x) => x.args.p_limit === 1),
    "one at a time",
  );
  eq(
    c.calls.filter((x) => x.name === "career_apply_finish_own").map((
      x,
    ) => [x.args.p_id, x.args.p_lease, x.args.p_state]),
    [[J1, `L-${J1}`, "confirmed"], [J2, `L-${J2}`, "confirmed"]],
  );
  assert(!c.calls.some((x) => /^career_apply_(claim|finish)$/.test(x.name)), "never the all-users functions");
});

Deno.test("WO-021/9 a queue that cannot be read runs nothing and is asked again", async () => {
  const c = fakeClient({ claimFails: 2, jobs: [queuedJob(J1)] });
  const r = await loop(c, { rounds: 3 });
  eq(r.runs.length, 1);
  eq(r.logs.filter((l) => l.includes("could not be read")).length, 2);
  eq(r.ran.map((x) => x.state), ["confirmed"]);
});

Deno.test("WO-021/10 recording is retried; an outcome that cannot be recorded is said, and the engine never runs again", async () => {
  const flaky = fakeClient({ finishFails: 2, jobs: [queuedJob(J1)] });
  const a = await loop(flaky, { rounds: 2 });
  eq(a.ran.map((x) => [x.state, x.recorded]), [["confirmed", true]]);
  eq(flaky.calls.filter((x) => x.name === "career_apply_finish_own").length, 3, "two failures, then recorded once");
  const down = fakeClient({ finishFails: 99, jobs: [queuedJob(J1)] });
  const b = await loop(down, { rounds: 3 });
  eq(b.runs.length, 1, "the application is never sent twice");
  eq(b.ran.map((x) => [x.state, x.recorded]), [["confirmed", false]]);
  assert(b.logs.some((l) => l.includes("NOT RECORDED")), "the person is told it was not recorded");
});

Deno.test("WO-021/11 an engine that started and gave no result is recorded unknown by the worker, not retried", async () => {
  const c = fakeClient({ jobs: [queuedJob(J1)] });
  let runs = 0;
  const r = await loop(c, { rounds: 3, engine: async () => (runs++, null) });
  eq(runs, 1);
  eq(r.ran.map((x) => x.state), ["unknown_outcome"]);
  eq(c.calls.filter((x) => x.name === "career_apply_finish_own").map((x) => x.args.p_state), ["unknown_outcome"]);
});

Deno.test("WO-021/12 an expired sign-in stops the worker with a plain line, instead of asking the queue forever", async () => {
  const c = fakeClient({ expired: true, jobs: [queuedJob(J1)] });
  const r = await loop(c, { rounds: 50 });
  eq(r.runs.length, 0);
  eq(c.calls.length, 1, "asked once, then stopped");
  assert(r.logs.some((l) => l.includes("sign-in has expired")), r.logs.join(" | "));
});

Deno.test("WO-021/13 a service key is recognized so a person's computer can refuse it", () => {
  const tok = (role: string) => "x." + btoa(JSON.stringify({ role })).replace(/=+$/, "") + ".y";
  eq(jwtRole(tok("service_role")), "service_role");
  eq(jwtRole(tok("authenticated")), "authenticated");
  eq(jwtRole("not-a-token"), null);
});

Deno.test("WO-021/G6 an employer's answer with no proof of the click is never recorded as confirmed", async () => {
  const h = harness({
    runEngine: async () => ({ result: { state: "confirmed", reason: "employer confirmation on the page", confirmation_id: "C-1" }, evidence: {} }),
  });
  await runApproved(h.deps);
  eq(h.finished, [{ id: J1, lease: "L1", state: "submitted_unconfirmed", reason: "employer confirmation on the page" }]);
});

Deno.test("WO-021/G6 a proof bound to another application is refused, and the outcome is never confirmed", async () => {
  const h = harness({
    runEngine: async (args: string[]) => ({
      result: { state: "confirmed", reason: "employer confirmation on the page", confirmation_id: "C-1", proof: { ...proofFor(args), application_id: J_OTHER } },
      evidence: {},
    }),
  });
  await runApproved(h.deps);
  eq(h.finished, [{ id: J1, lease: "L1", state: "submitted_unconfirmed", reason: "employer confirmation on the page" }]);
});
