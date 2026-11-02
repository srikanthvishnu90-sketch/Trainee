// MASS APPLY (2026-11-01): ONE card for the batch. The hosted preparation's finish (cloud_prepare.ts handlePrepareBridge
// "finish") holds the card while the person still has an open question or another posting still waiting to be prepared,
// and, when the ready applications do not all fit one message, tells them all are ready instead of pushing a partial card
// (a second card). A read that fails holds nothing (pushed as before). Same harness as hosted-apply-unit.test.ts F17.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../supabase/functions/_shared/cloud_prepare.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";
const fresh = () => new Date().toISOString();

const row = { id: RID, user_id: U, job_ids: ["ashby:ramp:1"], lease_token: LEASE, state: "running", claimed_at: fresh() };
const prepared = { id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", company: "Ramp", card_lines: ["Ramp: Software Engineering Intern, Frontend", "Email: a@example.test"], created_at: fresh() };
async function run(ready: any[], o: { open?: any[] | Error; waiting?: any[] | Error } = {}) {
  const calls: any[] = [];
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_request_ready") return ready;
      if (name === "career_apply_prepare_request_questions") return [];
      if (name === "career_apply_questions_open_as") { if (o.open instanceof Error) throw o.open; return o.open ?? []; }
      if (name === "career_apply_prepare_candidates") { if (o.waiting instanceof Error) throw o.waiting; return o.waiting ?? []; }
      if (name === "career_apply_card_push_requested_for") return "dddddddd-bbbb-4ccc-8ddd-0000000000f4";
      if (name === "career_apply_prepare_request_notice") return true;
      if (name === "career_apply_prepare_request_finish") return { state: "done" };
      throw Error(name);
    } };
  const outcomes = ready.map(() => ({ job_id: "ashby:ramp:1", outcome: "ready", detail: "" }));
  const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), outcomes }, deps);
  return { push: (out.body as any).push, calls };
}

Deno.test("held while a question of theirs is open, or another posting of theirs waits to be prepared; never for another person's", async () => {
  const w = await run([prepared], { open: [{ id: "eeeeeeee-bbbb-4ccc-8ddd-0000000000f7", key: "job:x:why", state: "open" }] });
  eq(w.push, "held_for_answers");
  assert(!w.calls.some((c) => c.name === "career_apply_card_push_requested_for" || c.name === "career_apply_prepare_request_notice"));
  eq((await run([prepared], { waiting: [{ user_id: U, job_id: "ashby:other:2" }] })).push, "held_for_answers");
  eq((await run([prepared], { waiting: [{ user_id: "99999999-bbbb-4ccc-8ddd-000000000099", job_id: "ashby:other:2" }, { user_id: U, job_id: "ashby:ramp:1" }] })).push, "shown");
});

Deno.test("a read that fails holds nothing: pushed as before", async () => {
  eq((await run([prepared], { open: Error("down") })).push, "shown");
  eq((await run([prepared], { waiting: Error("down") })).push, "shown");
});

Deno.test("ready applications too long for one message: no partial card; told all are ready", async () => {
  const long = (i: number) => ({ ...prepared, id: `cccccccc-bbbb-4ccc-8ddd-00000000010${i}`, company: `Co${i}`, card_lines: [`Co${i}: Engineer`, "x".repeat(2400)] });
  const p = await run([long(1), long(2)]);
  eq(p.push, "told_ready");
  assert(!p.calls.some((c) => c.name === "career_apply_card_push_requested_for"), "no partial card");
  eq(p.calls.find((c) => c.name === "career_apply_prepare_request_notice").args.p_text,
    'All 2 applications are ready. Say "show my applications" to see every one on one card and approve them with one tap. Nothing was sent.');
});
