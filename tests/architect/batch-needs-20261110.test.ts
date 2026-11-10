// Batch needs (2026-11-10). One batch of 12 postings; the open career_apply_questions rows (unique per user and key)
// say what is still missing. Pure cases: de-duplicated across the 12 postings, counted, ordered (most postings first,
// per-application items last), never-by-text items apart. Turn cases (no Postgres): the question text names the count in
// one plain sentence, one question per message; an answer prepares again exactly the postings it was for that wait on
// nothing else (per posting, not all or nothing), and the reply names what the rest still need.
import assertNode from "node:assert/strict";
import { batchNeeds, batchReadyText, neededSentence, type NeedRow, orderAsks, readyPostings } from "../../supabase/functions/_shared/batch_needs.ts";
import { type OpenQuestion, PER_TEXT, type QuestionStore, questionsText, questionsTurn, type Shown } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { prepareAfterAnswers } from "../../supabase/functions/_shared/career_hosted_prepare.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const U = "00000000-0000-4000-8000-0000000b4701", T = "00000000-0000-4000-8000-0000000b4702";
const P = Array.from({ length: 12 }, (_, i) => `ashby:co${i + 1}:${i + 1}`); // the batch
const GRAD = "What's your graduation date (month and year)?";

const q = (id: string, key: string, label: string, job_ids: string[], extra: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id, key, kind: "fact", label, type: "input_text", options: [], company: null, job_ids, misfit: false, answer: null, ...extra,
});
const ROWS: OpenQuestion[] = [
  q("00000000-0000-4000-8000-00000000a001", "job:00000000000000e1", "Why do you want to work at Co1?", [P[0]], { kind: "essay", type: "textarea", company: "Co1" }),
  q("00000000-0000-4000-8000-00000000a002", "fact:graduation_date", GRAD, P.slice(0, 7)),
  q("00000000-0000-4000-8000-00000000a003", "label:00000000000000a3", "Are you willing to relocate?", P.slice(1), { type: "checkbox", options: ["Yes", "No"] }),
  q("00000000-0000-4000-8000-00000000a004", "label:00000000000000a4", "Passport number", P.slice(0, 3)),
  q("00000000-0000-4000-8000-00000000a005", "job:00000000000000e5", "Gender", [P[4]], { options: ["Female", "Male", "Decline to self-identify"] }),
  q("00000000-0000-4000-8000-00000000a006", "fact:start_date", "Earliest start date", ["ashby:elsewhere:99"]), // not in this batch
];

Deno.test("batch needs: one item per question across the 12 postings, counted, most postings first, per-application last, never-by-text apart", () => {
  // The same key read twice (two reads merged, one posting more on the second): one item, never counted twice.
  const again: NeedRow = { key: "fact:graduation_date", label: GRAD, job_ids: [P[0], P[7]] };
  const answered: NeedRow = { key: "label:00000000000000ff", label: "Do you have a driver's license?", job_ids: P, state: "answered", answer: "Yes" };
  const b = batchNeeds([...ROWS, again, answered], P);
  eq(b.batch, 12);
  eq(b.items.map((n) => [n.key, n.needed, n.sensitive]), [
    ["label:00000000000000a3", 11, false],
    ["fact:graduation_date", 8, false],
    ["job:00000000000000e1", 1, true],
    ["job:00000000000000e5", 1, true],
  ]);
  eq(b.items[1].question, GRAD, "the employer's own words");
  eq(b.items[1].postings, [...P.slice(0, 8)].sort());
  assert(!b.items.some((n) => /passport/i.test(n.question)), "an identity number is never an item to ask");
  eq(b.onForm.map((n) => [n.key, n.needed]), [["label:00000000000000a4", 3]]);
  assert(!b.items.concat(b.onForm).some((n) => n.key === "fact:start_date"), "a question for no posting of the batch is not this batch's");
  assert(!b.items.some((n) => n.key === "label:00000000000000ff"), "an answered question is not missing");
  // Unblocks: the postings that question alone stands between and being prepared.
  eq(b.items.find((n) => n.key === "label:00000000000000a3")!.unblocks, 4, "postings 9 to 12 wait on it alone (8 has the date too)");
  eq(b.items.find((n) => n.key === "fact:graduation_date")!.unblocks, 0);
  eq(batchNeeds([], P), { items: [], onForm: [], batch: 12 });
});

Deno.test("the ask order and the count sentence", () => {
  eq(orderAsks(ROWS, P).map((x) => x.id.slice(-4)), ["a003", "a002", "a004", "a001", "a005", "a006"], "most postings first; ties oldest first");
  eq(orderAsks(ROWS, P, { perApplicationLast: true }).map((x) => x.id.slice(-4)), ["a003", "a002", "a004", "a006", "a001", "a005"]);
  eq(neededSentence(ROWS[1], P), "It's needed for 7 of your 12 applications.");
  eq(neededSentence({ job_ids: P }, P), "It's needed for all 12 of your applications.");
  eq(neededSentence({ job_ids: [P[0]] }, [P[0]]), "It's needed for your application.");
  eq(neededSentence(ROWS[1], null), "It's needed for 7 of your applications.", "without the batch, the postings it names");
  eq(neededSentence({ job_ids: ["x"] }, null), "It's needed for one of your applications.");
  eq(neededSentence({ job_ids: [] }, P), "");
});

Deno.test("the question text: one question, the count in one plain sentence; an identity number is never asked", () => {
  eq(PER_TEXT, 1);
  const t = questionsText(orderAsks(ROWS.slice(1, 4), P), 3, undefined, P)!;
  eq(t.take.length, 1);
  assert(t.text.includes("Are you willing to relocate? (Yes / No) It's needed for 11 of your 12 applications."), t.text);
  assert(!t.text.includes(GRAD) && !/passport/i.test(t.text), t.text);
  const g = questionsText([ROWS[3], ROWS[1]], 2, undefined, P)!;
  assert(g.text.includes(`${GRAD} It's needed for 7 of your 12 applications.`), g.text);
  eq(g.take.map((x) => x.id), [ROWS[1].id], "the passport question is skipped, never asked");
  eq(questionsText([ROWS[3]], 1, undefined, P), null);
});

Deno.test("ready postings: those waiting on no open question; an open question whose postings cannot be read holds them all", () => {
  eq(readyPostings(ROWS.slice(1, 3), P), [], "every posting waits on the date or relocation");
  eq(readyPostings([ROWS[2]], P), [P[0]]);
  eq(readyPostings([{}], P), [], "unreadable: fail closed");
  eq(readyPostings([], P), P);
});

Deno.test("the batch's readiness text", () => {
  eq(batchReadyText({ ready: 12, total: 12, still: [] }), "All 12 are ready to send. Reply yes to send all 12.");
  eq(batchReadyText({ ready: 1, total: 1, still: [] }), "Your application is ready to send. Reply yes to send it.");
  eq(batchReadyText({ ready: 5, total: 12, still: [GRAD, GRAD] }), `5 of 12 are ready; 7 still need you: ${GRAD}`);
  eq(batchReadyText({ ready: 11, total: 12, still: ["Gender"] }), "11 of 12 are ready; 1 still needs you: Gender.");
  eq(batchReadyText({ ready: 13, total: 12, still: [] }), "");
});

// ---------------------------------------------------------------------------------------------------------- turns
function world(rows: OpenQuestion[], queue: string[]) {
  const qs = rows.map((x) => ({ ...x })), answered = new Map<string, string>();
  let shown: Shown | null = null, last: string | null = null;
  const openRows = () => qs.filter((r) => !answered.has(r.id));
  const store: QuestionStore = {
    open: async (_u, limit) => openRows().slice(0, limit),
    countOpen: async () => openRows().length,
    get: async (_u, ids) => qs.filter((r) => ids.includes(r.id)),
    answer: async (_u, id, a) => { answered.set(id, a); },
    shown: async () => shown,
    setShown: async (_u, s) => { shown = structuredClone(s); },
    lastAssistantIntent: async () => last,
    batch: async () => queue,
  };
  // The admin reads prepareAfterAnswers makes: the open-question probe, the queue, and every open question with its postings.
  const admin = {
    rpc: async (name: string) => ({ data: name === "career_apply_questions_open_as" ? openRows().slice(0, 1) : null, error: null }),
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async (a: number, b: number) => {
      const all = table === "career_apply_wanted" ? queue.map((k) => ({ posting_key: k }))
        : table === "career_apply_questions" ? openRows().map((r) => ({ key: r.key, label: r.label, job_ids: r.job_ids, state: "open" })) : [];
      return { data: all.slice(a, b + 1), error: null };
    } }) }) }) }) }),
  };
  const kicked: string[][] = [];
  const env = { get: (k: string) => ({ CAREER_PREPARE_AHEAD_URL: "http://runner.test/prepare", CAREER_PREPARE_AHEAD_TOKEN: "TEST-token" } as Record<string, string>)[k] };
  const fetch = (async (_u: unknown, init?: RequestInit) => { kicked.push(JSON.parse(String(init?.body)).job_ids); return new Response("", { status: 202 }); }) as typeof globalThis.fetch;
  const turn = async (message: string) => {
    const r = (await questionsTurn({ message, userId: U, threadId: T, now: Date.now(), store, situation: undefined }))!;
    last = ["shown", "partial", "answered_next"].includes(r.status) ? "career_apply_questions" : "other";
    return r;
  };
  return { store, admin, env, fetch, kicked, answered, turn };
}

Deno.test("turn: the count is said; an answer prepares again only the postings it readied; the rest wait, named; all answered prepares the batch", async () => {
  // Posting 1 needs only the date; postings 2 to 7 the date and relocation; 8 to 12 relocation.
  const w = world([ROWS[1], ROWS[2]], P);
  const a = await w.turn("what do you need from me");
  eq(a.status, "shown");
  assert(a.reply.includes("Are you willing to relocate? (Yes / No) It's needed for 11 of your 12 applications.") && !a.reply.includes(GRAD), a.reply);
  const b = await w.turn("yes");
  eq([b.status, w.answered.get(ROWS[2].id)], ["answered_next", "Yes"], b.reply);
  eq(b.jobs!.slice().sort(), P.slice(1).sort(), "the postings that answer was for");
  eq(await prepareAfterAnswers(b, { admin: w.admin, userId: U, env: w.env, fetch: w.fetch }), "started");
  eq(w.kicked, [P.slice(7)], "postings 8 to 12 wait on nothing else now; 1 to 7 still wait on the date");
  assert(b.reply.includes(`I'm preparing 5 of your applications again now with these answers; 7 still need you: ${GRAD} The card with every exact answer comes here once those are answered too.`), b.reply);
  assert(b.reply.slice(b.reply.indexOf("\n\nNext: ")).includes(`${GRAD} It's needed for 7 of your 12 applications.`), b.reply);
  eq(b.reply.slice(b.reply.indexOf("\n\nNext: ")).split(/only you can answer/).length, 2, "still one question in the message");
  const c = await w.turn("May 2026");
  eq(c.status, "answered", c.reply);
  eq(await prepareAfterAnswers(c, { admin: w.admin, userId: U, env: w.env, fetch: w.fetch }), "started");
  eq(w.kicked.at(-1), P, "nothing open: every queued posting is prepared again, as before");
  assert(/I'm preparing your application again now with these answers/.test(c.reply), c.reply);
});

Deno.test("turn: an answer whose postings all still wait prepares nothing; an unreadable question holds everything", async () => {
  // Relocation and the date asked by the same 7 postings: answering one readies none of them, so nothing is prepared.
  const x = world([q(ROWS[2].id, ROWS[2].key, ROWS[2].label, P.slice(0, 7), { type: "checkbox", options: ["Yes", "No"] }), ROWS[1]], P);
  await x.turn("what do you need from me");
  const r = await x.turn("no");
  eq(r.status, "answered_next", r.reply);
  eq(await prepareAfterAnswers(r, { admin: x.admin, userId: U, env: x.env, fetch: x.fetch }), "skipped");
  eq(x.kicked.length, 0);
  assert(!/preparing/.test(r.reply), r.reply);
  // An open question whose postings cannot be read: nothing is prepared again (fail closed).
  const blind = { ...x.admin, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: [{ posting_key: P[0] }], error: null }) }) }) }) }) }) };
  const again = { reply: "Saved. I won't ask this again:\nx\n\nNext: y", status: "answered_next", jobs: [P[0]] };
  eq(await prepareAfterAnswers(again, { admin: blind, userId: U, env: x.env, fetch: x.fetch }), "skipped");
  eq(x.kicked.length, 0);
});
