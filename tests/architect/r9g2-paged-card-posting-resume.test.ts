// R9-G2: (E05) a batch too big for one card text is pushed as ONE card in numbered pages, and a texted yes approves it only
// once every page was delivered and only while the set is unchanged; (E09) a resume tailored for one posting is the file
// that posting's hosted application sends, and the card names it. The database rules are tests/db/career_apply_card_pages
// and tests/db/career_apply_posting_resume; here the code that calls them. No network, no database.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { cardTurn, type CardStore, PAGE_CHARS } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { keptResume } from "../../workers/career-cloud/prepare-runner.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-r9g2-runner-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000002a1", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000002f1", LEASE = "11111111-2222-4333-8444-0000000002f1";
const prepared = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, company: `Employer ${n}`,
  card_lines: [`Employer ${n}`, `First Name: Alex`, `Last Name: Testcase`, `Email: alex.testcase@example.test`, `Resume: Alex_Resume.pdf (${"a".repeat(12)})`,
    `Sends to https://boards.greenhouse.io/employer${n}/jobs/${n}`], resume_sha256: "a".repeat(64) });

function bridge(o: { ready: any[]; resume?: Record<string, any> }) {
  const calls: { name: string; args: any }[] = [];
  const row = { id: RID, user_id: U, job_ids: o.ready.map((_, i) => `greenhouse:employer${i + 1}:${i + 1}`), lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const deps = {
    secret: SECRET, readRequest: async () => row,
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_request_ready") return o.ready;
      if (name === "career_apply_questions_open_as") return [];
      if (name === "career_apply_prepare_candidates_for") return [];
      if (name === "career_apply_card_push_paged_for" || name === "career_apply_card_push_requested_for") return "c0000000-0000-4000-8000-000000000001";
      if (name === "career_apply_cloud_resume_for_posting") return o.resume?.[args.p_posting] ?? null;
      if (name === "career_apply_cloud_resume_kept_for") return { filename: "Alex_Resume.pdf", sha256: "a".repeat(64), b64: "" };
      return { state: "done" };
    },
  };
  const call = async (op: string, extra: any = {}) => handlePrepareBridge(op, { id: RID, sandbox: "sbx_1", token: await prepareToken(SECRET, RID, LEASE, "sbx_1"), ...extra }, deps as any);
  return { call, calls };
}

Deno.test("E05: a batch too big for one card text is pushed as ONE card in numbered pages, each one text (before: 'say show my applications', no card)", async () => {
  const ready = Array.from({ length: 20 }, (_, i) => prepared(i + 1));
  const b = bridge({ ready });
  const r = await b.call("finish", { outcomes: ready.map((_, i) => ({ job_id: `greenhouse:employer${i + 1}:${i + 1}`, outcome: "ready", detail: "" })) });
  eq((r.body as any).push, "shown_paged", JSON.stringify(r.body));
  const push = b.calls.find((c) => c.name === "career_apply_card_push_paged_for")!;
  ok(push, "the paged push was called");
  eq(push.args.p_ids, ready.map((p) => p.id), "every application, in order, on the one card");
  const pages: string[] = push.args.p_pages, n = pages.length;
  ok(n >= 2, `${n} pages`);
  pages.forEach((p, i) => { ok(p.startsWith(`${i + 1}/${n}\n`), `page ${i + 1} is numbered ${i + 1}/${n}`); ok(p.length <= 4000 && p.length <= PAGE_CHARS + 20, `page ${i + 1} fits one text (${p.length})`); });
  const all = pages.join("\n\n");
  for (const p of ready) for (const l of p.card_lines) ok(all.includes(l), `every line on the card: ${l}`);
  ok(/one "yes" approves all 20/.test(pages[0]), "the card says one yes approves all of it");
  ok(!b.calls.some((c) => c.name === "career_apply_prepare_request_notice"), "no 'show my applications' notice instead of the card");
});

Deno.test("E05: a batch that fits one text is still one card in one text, as before", async () => {
  const ready = [prepared(1), prepared(2)];
  const b = bridge({ ready });
  const r = await b.call("finish", { outcomes: [] });
  eq((r.body as any).push, "shown");
  ok(b.calls.some((c) => c.name === "career_apply_card_push_requested_for") && !b.calls.some((c) => c.name === "career_apply_card_push_paged_for"));
});

function store(answer: CardStore["answer"]): CardStore {
  return {
    pending: async () => [], open: async () => ({ id: "card-1", items: [] } as any), latestOpen: async () => ({ id: "card-1", items: [1, 2, 3].map((n) => ({ n, prepared_id: `p${n}`, payload_hash: "h" })), shown_at: new Date().toISOString() } as any),
    answer, lastAssistantIntent: async () => "career_apply_card", lastShownCard: async () => "card-1",
  } as any;
}
Deno.test("E05: a yes to a paged card before every page arrived, or after the set changed, approves nothing and says why", async () => {
  const turn = (msg: string) => cardTurn({ message: "yes", userId: U, threadId: "t1", now: Date.now(), store: store(async () => { throw new Error(msg); }) });
  const a = await turn("card_pages_undelivered");
  eq(a?.status, "pages_undelivered");
  ok(/nothing was approved and nothing was sent/.test(a!.reply), a!.reply);
  const b = await turn("APPROVAL_SET_CHANGED");
  eq(b?.status, "set_changed");
  ok(/APPROVAL_SET_CHANGED/.test(b!.reply) && /nothing was approved/.test(b!.reply), b!.reply);
});

Deno.test("E09: each posting's application reads its own tailored resume when one is kept for it; every other posting the kept one", async () => {
  const tailored = { filename: "Alex_Resume_tailored_Lumen.pdf", sha256: "b".repeat(64), b64: "", posting: "greenhouse:employer1:1" };
  const b = bridge({ ready: [prepared(1), prepared(2)], resume: { "greenhouse:employer1:1": tailored } });
  eq(((await b.call("resume", { posting: "greenhouse:employer1:1" })).body as any).filename, "Alex_Resume_tailored_Lumen.pdf");
  eq(((await b.call("resume", { posting: "greenhouse:employer2:2" })).body as any).filename, "Alex_Resume.pdf", "no tailored copy: the kept resume");
  eq(((await b.call("resume", { posting: "greenhouse:not-this-request:9" })).body as any).filename, "Alex_Resume.pdf", "a posting not in the request reads only the kept one");
  eq(((await b.call("resume")).body as any).filename, "Alex_Resume.pdf");
  // The runner asks for the posting it prepares.
  const asked: any[] = [];
  const dir = await Deno.makeTempDir();
  try {
    await keptResume(async (_op, extra) => { asked.push(extra); return null; })({ job_id: "greenhouse:employer1:1" }, dir);
    eq(asked, [{ posting: "greenhouse:employer1:1" }]);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
