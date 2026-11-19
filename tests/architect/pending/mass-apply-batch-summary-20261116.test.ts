// D-094 (owner, 2026-11-16): one request whose batch would need pages (more than one text) is ONE summary card plus its File,
// not a card of numbered pages; a batch whose card fits one text is shown inline exactly as before. The bridge's finish with an
// rpc double and a File double (the database half: tests/db/career_apply_batch_file.test.sql; end to end:
// mass-apply-batch-file-20261116.test.ts). No network, no database.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-d094-summary-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0961", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000d0961", LEASE = "11111111-2222-4333-8444-0000000d0961";
const CARD = "c0000000-0000-4000-8000-0000000d0961", URL = "https://file.d094.test?t=v1.TEST";
const prepared = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, company: `Employer ${n}`, role: "Operations Associate",
  card_lines: [`Employer ${n}`, "First Name: Alex", "Last Name: Testcase", "Email: alex.testcase@example.test", `Why this role?: TEST answer ${n}`, "Resume: Alex_Resume.pdf",
    `Sends to https://jobs.lever.co/employer${n}/${n}`], resume_sha256: "a".repeat(64) });

async function finish(ready: any[]) {
  const calls: { name: string; args: any }[] = [], files: any[][] = [];
  const deps = { secret: SECRET, stop: async () => {},
    readRequest: async () => ({ id: RID, user_id: U, job_ids: ready.map((_, i) => `lever:employer${i + 1}:${i + 1}`), lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() }),
    batchFile: async (_u: string, rows: any[]) => { files.push(rows); return { id: "0123456789", url: URL }; },
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_batch_done") return { batch: RID, requests: 1, open: 0 };
      if (name === "career_apply_prepare_batch_ready" || name === "career_apply_prepare_request_ready") return ready;
      if (/^career_apply_card_push_/.test(name)) return CARD;
      if (name === "career_apply_prepare_request_finish") return { state: "done" };
      return [];
    } };
  const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_s", token: await prepareToken(SECRET, RID, LEASE, "sbx_s"),
    outcomes: ready.map((_, i) => ({ job_id: `lever:employer${i + 1}:${i + 1}`, outcome: "ready", detail: "" })) }, deps as any);
  return { body: out.body as any, calls, files };
}

Deno.test("20 ready in one request (a card that needs pages): ONE summary card and its File (before: numbered pages)", async () => {
  const ready = Array.from({ length: 20 }, (_, i) => prepared(i + 1));
  const r = await finish(ready);
  eq(r.body.push, "shown_file", JSON.stringify(r.body));
  ok(!r.calls.some((c) => c.name === "career_apply_card_push_paged_for"), "no paged card");
  eq(r.files.length, 1, "one File");
  eq(r.files[0].map((p: any) => p.id), ready.map((p) => p.id), "the File is made of every application, in card order");
  const push = r.calls.find((c) => c.name === "career_apply_card_push_batch_for")!;
  eq(push.args.p_ids, ready.map((p) => p.id), "the card's items are the File's, in order");
  eq(push.args.p_file, "0123456789", "the card names its File");
  const text: string = push.args.p_text;
  ok(text.length <= 1600, `one short message (${text.length})`);
  ok(/^20 applications are ready\./.test(text) && text.includes(URL) && /and 15 more/.test(text), text);
  ok(!text.includes("TEST answer 7"), "the answers are in the File, not the chat");
});

Deno.test("2 ready (fits one text): inline exactly as before, every line on the card, no File", async () => {
  const ready = [prepared(1), prepared(2)];
  const r = await finish(ready);
  eq(r.body.push, "shown");
  ok(r.calls.some((c) => c.name === "career_apply_prepare_batch_done"), "its finish is recorded in its batch (a batch of one)");
  eq(r.files.length, 0, "no File");
  const push = r.calls.find((c) => c.name === "career_apply_card_push_requested_for")!;
  for (const p of ready) for (const l of p.card_lines) ok(push.args.p_text.includes(l), l);
});
