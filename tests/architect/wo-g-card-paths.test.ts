// WO-G, architect rulings on #632 (R10 fix 12): (2) every card path carries the review File link of each application on
// it, and (3) an unresolved required fact is never approvable through any path: a card yes, a Telegram tap or the jobs
// page's one-tap Confirm holds back each item whose posting still has an open required question and says its narrow
// question instead; a check that cannot be read approves nothing. Fake model and fake clients only: no network, $0.
// Fail-first: on #632's earlier head 91e40547 the pushed cards (cloud_prepare.ts, career_prepare_ahead.ts, career-proactive)
// carried no review link, and every approval door approved an item whose posting still had an open required question.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { supabaseCardPush, supabaseReviewLinks } from "../../supabase/functions/_shared/application_review_links.ts";
import { supabaseAheadStore } from "../../supabase/functions/_shared/career_prepare_ahead.ts";
import { answerText, cardTurn, supabaseCardStore } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { supabaseTapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname;
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000a0c01", SHA = "b".repeat(64);
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
const env = { get: (k: string) => ENV[k] };
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (n: number) => `greenhouse:wogc${n}:${100 + n}`;
const payload = (n: number) => ({ version: 1, user_id: U, job_id: job(n), company: `TEST Employer ${n}`, url: `https://boards.greenhouse.io/wogc${n}/jobs/${100 + n}`,
  destination: `https://boards.greenhouse.io/wogc${n}/jobs/${100 + n}`, resume_sha256: SHA, page_field_names: [], fields: [{ name: "first_name", label: "First Name", value: "Ada" }] });
const lines = (n: number, pad = 0) => [`TEST Employer ${n}`, `First Name: Ada`, ...Array.from({ length: pad }, (_, i) => `TEST note ${i}: ${"x".repeat(90)}`), `Resume: Ada_Resume.pdf (${SHA.slice(0, 12)})`, `Sends to https://boards.greenhouse.io/wogc${n}/jobs/${100 + n}`];
const prepared = (n: number, pad = 0) => ({ id: pid(n), company: `TEST Employer ${n}`, card_lines: lines(n, pad), resume_sha256: SHA });

// A small service client over in-memory tables: select/eq/in/limit/order, upsert/insert, and the RPCs a test names.
function fakeAdmin(o: { tables: Record<string, any[]>; rpc: Record<string, (args: any) => any> }) {
  const calls: { name: string; args: any }[] = [];
  const q = (table: string) => {
    let rows = [...(o.tables[table] ??= [])];
    const b: any = {
      select: () => b, order: () => b, range: () => b, limit: (n: number) => { rows = rows.slice(0, n); return b; },
      eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return b; }, in: (k: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[k])); return b; },
      upsert: (row: any) => { o.tables[table] = [...o.tables[table].filter((r) => !(r.user_id === row.user_id && r.key === row.key)), row]; return Promise.resolve({ data: null, error: null }); },
      insert: (row: any) => { o.tables[table].push(row); return Promise.resolve({ data: null, error: null }); },
      then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    };
    return b;
  };
  return { calls, from: q, rpc: async (name: string, args: any) => {
    calls.push({ name, args });
    const f = o.rpc[name];
    if (!f) return { data: null, error: { message: `no rpc ${name}` } };
    try { return { data: await f(args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  } };
}
// The world: prepared applications 1..n (the first with an open required question on its posting), their postings.
async function world(n: number, o: { openOn?: number[]; openFails?: boolean } = {}) {
  const prep = await Promise.all(Array.from({ length: n }, async (_, i) => ({ id: pid(i + 1), user_id: U, job_id: job(i + 1), company: `TEST Employer ${i + 1}`,
    payload: payload(i + 1), payload_hash: await hashApplyPayload(payload(i + 1)), card_lines: lines(i + 1) })));
  const open = (o.openOn ?? []).map((k) => ({ label: "Will you continue an outside business while employed?", options: ["Yes", "No"], company: `TEST Employer ${k}`, job_ids: [job(k)] }));
  return fakeAdmin({
    tables: { career_apply_prepared: prep, career_postings: prep.map((p, i) => ({ job_id: p.job_id, title: `TEST Analyst ${i + 1}` })), career_watch_kv: [],
      career_apply_cards: [{ id: "C1", user_id: U, items: prep.map((p, i) => ({ n: i + 1, prepared_id: p.id, payload_hash: p.payload_hash })) }] },
    rpc: {
      career_apply_questions_open_as: () => { if (o.openFails) throw Error("down"); return open; },
      career_apply_card_answer_as: (a: any) => prep.map((p, i) => ({ n: i + 1, company: p.company, result: a.p_approve.includes(i + 1) ? "queued" : "declined" })),
      career_apply_card_confirm_as: () => ({ card: { id: "C2" }, results: [{ n: 1, company: "TEST Employer 1", result: "queued" }] }),
      career_apply_card_push_as: () => "C9",
    },
  });
}
const LINKS = /The full review of each, with the application page, the resume file and exactly what your yes covers:\n1\. TEST Employer 1, TEST Analyst 1: https:\/\/trainee\.example\/file/;

Deno.test("WO-G ruling 2: the hosted preparation's card (career_apply_card_push_requested_for), one text and one-page batch, ends with the review links", async () => {
  const SECRET = "TEST-wog-runner-secret-0123456789abcdef0123", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000a0c01", LEASE = "11111111-2222-4333-8444-0000000a0c01";
  for (const n of [1, 8]) {
    const ready = Array.from({ length: n }, (_, i) => prepared(i + 1)), calls: { name: string; args: any }[] = [], asked: string[][] = [];
    const deps = { secret: SECRET, readRequest: async () => ({ id: RID, user_id: U, job_ids: ready.map((_, i) => job(i + 1)), lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() }),
      review: async (_u: string, ids: string[]) => { asked.push(ids); return `The full review of each, with the application page, the resume file and exactly what your yes covers:\n1. TEST Employer 1, TEST Analyst 1: https://trainee.example/file/x`; },
      rpc: async (name: string, args: any) => { calls.push({ name, args });
        if (name === "career_apply_prepare_request_ready") return ready;
        if (name === "career_apply_questions_open_as" || name === "career_apply_prepare_candidates_for") return [];
        if (name === "career_apply_card_push_requested_for") return "c0000000-0000-4000-8000-0000000a0c01";
        return { state: "done" }; } };
    const r = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_1", token: await prepareToken(SECRET, RID, LEASE, "sbx_1"), outcomes: [] }, deps as any);
    eq((r.body as any).push, "shown", `${n}`);
    const push = calls.find((x) => x.name === "career_apply_card_push_requested_for")!;
    assert(LINKS.test(push.args.p_text) && push.args.p_text.length <= 4000, push.args.p_text);
    for (const p of ready) for (const l of p.card_lines) assert(push.args.p_text.includes(l), `${n}: ${l}`);
    eq(asked, [ready.map((p) => p.id)], "one review per application on the card");
  }
});

Deno.test("WO-G ruling 2: the paged card (career_apply_card_push_paged_for) carries the review links on its last page", async () => {
  const SECRET = "TEST-wog-runner-secret-0123456789abcdef0123", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000a0c02", LEASE = "11111111-2222-4333-8444-0000000a0c02";
  const ready = Array.from({ length: 12 }, (_, i) => prepared(i + 1, 4)), calls: { name: string; args: any }[] = [];
  const deps = { secret: SECRET, readRequest: async () => ({ id: RID, user_id: U, job_ids: ready.map((_, i) => job(i + 1)), lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() }),
    review: async () => "The full review of each, with the application page, the resume file and exactly what your yes covers:\n1. TEST Employer 1, TEST Analyst 1: https://trainee.example/file/x",
    rpc: async (name: string, args: any) => { calls.push({ name, args });
      if (name === "career_apply_prepare_request_ready") return ready;
      if (name === "career_apply_questions_open_as" || name === "career_apply_prepare_candidates_for") return [];
      if (name === "career_apply_card_push_paged_for") return "c0000000-0000-4000-8000-0000000a0c02";
      return { state: "done" }; } };
  const r = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_1", token: await prepareToken(SECRET, RID, LEASE, "sbx_1"), outcomes: [] }, deps as any);
  eq((r.body as any).push, "shown_paged");
  const pages: string[] = calls.find((x) => x.name === "career_apply_card_push_paged_for")!.args.p_pages;
  assert(pages.length >= 2 && LINKS.test(pages.at(-1)!) && pages.every((p) => p.length <= 4000), pages.at(-1));
  assert(pages.slice(0, -1).every((p) => !/full review/.test(p)), "the links ride on the last page only");
});

Deno.test("WO-G ruling 2: the prepare-ahead and scheduled card pushes (career_apply_card_push_as) carry a real review File link per application", async () => {
  const admin = await world(2);
  const review = supabaseReviewLinks(admin, env);
  const text = [`2 applications are ready. Every answer below goes exactly as shown.`, ...[1, 2].map((n) => lines(n).join("\n"))].join("\n\n");
  eq(await supabaseAheadStore(admin, review).push(U, [pid(1), pid(2)], text), "C9");
  eq(await supabaseCardPush(admin, review)(U, [pid(1), pid(2)], text), "C9");
  const pushes = admin.calls.filter((c) => c.name === "career_apply_card_push_as");
  eq(pushes.length, 2);
  for (const p of pushes) assert(p.args.p_text.startsWith(text) && LINKS.test(p.args.p_text) && /\n2\. TEST Employer 2, TEST Analyst 2: https:\/\/trainee\.example\/file/.test(p.args.p_text), p.args.p_text);
  const files = (admin as any).from("career_watch_kv");
  const kept = await files;
  assert(kept.data.length === 4 && kept.data.every((r: any) => r.value.kind === "application_review" && r.value.data.from_prepared === true), "four review Files, built by code");
  // The scheduled push is wired to it (career-proactive/index.ts), as the prepare-ahead worker is (workers/career-browser/prepare-ahead.ts).
  const idx = await Deno.readTextFile(`${ROOT}supabase/functions/career-proactive/index.ts`), worker = await Deno.readTextFile(`${ROOT}workers/career-browser/prepare-ahead.ts`);
  assert(idx.includes("pushCard: supabaseCardPush(admin, supabaseReviewLinks(admin, Deno.env)),"), "career-proactive pushes through supabaseCardPush with the review links");
  assert(worker.includes("supabaseAheadStore(admin, supabaseReviewLinks(admin, Deno.env))"), "prepare-ahead pushes with the review links");
  const runner = await Deno.readTextFile(`${ROOT}supabase/functions/career-cloud-runner/index.ts`);
  assert(runner.includes("void p, review }));"), "the cloud runner hands the review links to the preparation's card push");
});

Deno.test("WO-G ruling 3: a card yes (chat) holds back the item whose posting has an open required question and says its narrow question; the rest are approved", async () => {
  const admin = await world(2, { openOn: [1] });
  const results = await supabaseCardStore(admin).answer(U, "C1", [1, 2]);
  eq(admin.calls.find((c) => c.name === "career_apply_card_answer_as")!.args.p_approve, [2], "only the resolved item reaches the database as approved");
  eq(results.map((r) => r.result), ["needs_answer", "queued"]);
  const text = answerText(results);
  assert(text.includes(`1. TEST Employer 1: not approved: a required answer is still missing. For TEST Employer 1, the form asks: "Will you continue an outside business while employed?". I don't have your answer, and I won't pick one for you. What should I enter? The form's choices: Yes / No.`), text);
  assert(/^1 approved exactly as shown; 1 of the 2 not sent/.test(text), text);
});

Deno.test("WO-G ruling 3: the Telegram tap and the one-tap Confirm (jobs page, File) refuse an unresolved item too; an unreadable check approves nothing", async () => {
  const tap = await world(2, { openOn: [1, 2] });
  const r = await supabaseTapStore(tap).answer(U, "C1", [1, 2]);
  eq([tap.calls.find((c) => c.name === "career_apply_card_answer_as")!.args.p_approve, r.map((x) => x.result)], [[], ["needs_answer", "needs_answer"]]);
  const conf = await world(1, { openOn: [1] });
  await assertNode.rejects(() => supabaseCardStore(conf).confirm!(U, [pid(1)], ["h"]), /needs_answer: For TEST Employer 1, the form asks/);
  assert(!conf.calls.some((c) => c.name === "career_apply_card_confirm_as"), "the database is never asked to confirm it");
  const down = await world(1, { openFails: true });
  await assertNode.rejects(() => supabaseCardStore(down).answer(U, "C1", [1]), /unresolved_unreadable/);
  assert(!down.calls.some((c) => c.name === "career_apply_card_answer_as"), "nothing is approved when the check cannot be read");
  // The chat says so instead of approving (cardTurn, a yes right after the card).
  const store = { ...supabaseCardStore(down), pending: async () => [], latestOpen: async () => ({ id: "C1", items: [{ n: 1, prepared_id: pid(1), payload_hash: "h" }], shown_at: new Date().toISOString() }),
    lastAssistantIntent: async () => "career_apply_card", lastShownCard: async () => "C1" };
  const said = await cardTurn({ message: "yes", userId: U, threadId: "TH", now: Date.now(), store: store as any });
  eq(said?.status, "unresolved_unreadable", said?.reply);
  assert(/nothing was approved and nothing was sent/.test(said!.reply), said!.reply);
  // The jobs page's Confirm says the narrow question (telegram_jobs.ts tapJob's needs_answer branch).
  const tj = await Deno.readTextFile(`${ROOT}supabase/functions/_shared/telegram_jobs.ts`);
  assert(tj.includes("Nothing was approved: a required answer is still missing. ${m[1]}"), "the Confirm path says the narrow question");
});
