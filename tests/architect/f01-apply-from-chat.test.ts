// FEATURE 1 (2026-10-25): apply from chat, the pieces the live turn lacked (career_apply_from_chat.ts and its use in
// career_apply_chat.ts): positions on the thread's last list, listed postings checked on file, no resume on file, the
// server prepare asked for exactly the rows queued (off unless the owner configures it), the coverage line, the store's
// own refusals, and the chat answer recorded where the queue executor reads (DIAGNOSIS F1). The handler-level proof is
// tests/architect/flow-f01-chat-to-apply.test.ts.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore, queueWants, type WantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import {
  chatAnswersRecorded, checkListed, coverageLine, hasConfirmedResume, kickPrepare, positionsOf, recordChatAnswers, type QueueAnswerStore,
} from "../../supabase/functions/_shared/career_apply_from_chat.ts";
import type { OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { prepareAhead, prepareDoor } from "../../workers/career-browser/prepare-ahead.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T16:00:00Z");
const LIST: ShortlistEntry[] = [
  { id: "greenhouse:a:1", title: "TEST Analyst", company: "Alpha Works", location: "Chicago, IL", url: "https://boards.greenhouse.io/a/jobs/1" },
  { id: "greenhouse:b:2", title: "TEST Analyst", company: "Bravo Labs", location: "Chicago, IL", url: "https://boards.greenhouse.io/b/jobs/2" },
  { id: "greenhouse:c:3", title: "Data Analyst", company: "Charlie Data", location: "Chicago, IL", url: "https://boards.greenhouse.io/c/jobs/3" },
  { id: "greenhouse:d:4", title: "Data Analyst", company: "Delta Freight", location: "Chicago, IL", url: "https://boards.greenhouse.io/d/jobs/4" },
];
const ON_FILE: Record<string, any> = {
  "greenhouse:a:1": { job_id: "greenhouse:a:1", company: "Alpha Works", title: "TEST Analyst", url: "https://boards.greenhouse.io/a/jobs/1", closed_at: null },
  "greenhouse:b:2": { job_id: "greenhouse:b:2", company: "Bravo Labs", title: "TEST Analyst", url: "https://boards.greenhouse.io/b/jobs/2", closed_at: "2026-10-24T00:00:00Z" },
  "greenhouse:c:3": { job_id: "greenhouse:c:3", company: "Charlie Data", title: "Data Analyst", url: "https://boards.greenhouse.io/c/jobs/3", closed_at: null },
  "greenhouse:d:4": { job_id: "greenhouse:d:4", company: "Delta Freight", title: "Data Analyst", url: "https://boards.greenhouse.io/d/jobs/4", closed_at: null },
};
// Charlie Data: the listed posting itself was applied to 10 days ago (blocks). Delta Freight: a different posting there was
// applied to 4 days ago (blocks nothing; D-MS-3: only an exact duplicate blocks, no one-per-company window).
const PRIOR = [
  { id: "j1", company: "Charlie Data", title: "Data Analyst", url: "https://boards.greenhouse.io/c/jobs/3", state: "submitted_unconfirmed", created_at: new Date(NOW - 10 * 86400_000).toISOString(), updated_at: "" },
  { id: "j2", company: "Delta Freight", title: "Ops Analyst", url: "https://boards.greenhouse.io/d/jobs/40", state: "submitted_unconfirmed", created_at: new Date(NOW - 4 * 86400_000).toISOString(), updated_at: "" },
];
function world(o: { resume?: boolean | null; kick?: "started" | "off" | "failed"; shortlist?: ShortlistEntry[]; postings?: any[]; prepareOn?: boolean } = {}) {
  const wants = memoryWantStore(), kicks: string[][] = [];
  const turn = (message: string) => applyTurn({
    message, userId: "u1", now: NOW, wants, apps: async () => PRIOR, facts: [], shortlist: o.shortlist ?? LIST,
    postings: { search: async () => o.postings ?? [] },
    posting: async (id) => ON_FILE[id] ?? null,
    resumeOnFile: async () => o.resume === undefined ? true : o.resume,
    prepare: async (ids) => { kicks.push(ids); return o.kick ?? "started"; },
    ...(o.prepareOn === undefined ? {} : { prepareOn: () => o.prepareOn! }),
  });
  return { wants, kicks, turn, keys: async () => (await wants.list("u1")).map((w) => w.posting_key).sort() };
}

Deno.test("F01 positions: '1 and 3', '#2', 'the 2nd one', 'the first and third', '1, 3 and 4'; a bare count stays a count; counts and broad asks unchanged", () => {
  eq(positionsOf("1 and 3"), [1, 3]);
  eq(positionsOf("1, 3 and 4"), [1, 3, 4]);
  eq(positionsOf("the first and third"), [1, 3]);
  eq(positionsOf("2nd and 4th ones"), [2, 4]);
  eq(positionsOf("#2"), [2]);
  eq(positionsOf("number 2 please"), [2]);
  eq(positionsOf("3"), null, "a bare number is not a position");
  eq(positionsOf("data analyst jobs"), null);
  eq(applyManyAsk("apply to 1 and 3"), { kind: "pick", is: [1, 3] });
  eq(applyManyAsk("Apply to #1 and #3."), { kind: "pick", is: [1, 3] });
  eq(applyManyAsk("apply to the 2nd one"), { kind: "nth", i: 2 });
  eq(applyManyAsk("apply to #2"), { kind: "nth", i: 2 });
  eq(applyManyAsk("apply to the first and third ones"), { kind: "pick", is: [1, 3] });
  eq(applyManyAsk("apply to all of them"), { kind: "all" });
  eq(applyManyAsk("apply to 3 roles"), { kind: "first", n: 3 });
  for (const m of ["apply to 25 data analyst jobs", "apply to 3", "how do I apply to 1 and 3?", "I applied to 1 and 3", "apply to the Data Analyst role at Acme"]) eq(applyManyAsk(m), null, m);
});

Deno.test("F01 'apply to 1 and 3' queues exactly those two from the list when they pass; the coverage line comes first; the prepare is asked for exactly the rows queued", async () => {
  const w = world();
  const r = await w.turn("apply to 1 and 4");
  eq([r?.status, r?.intent], ["queued", "career_apply_queue"], r?.reply);
  eq(await w.keys(), ["greenhouse:a:1", "greenhouse:d:4"]);
  assert(r!.reply.startsWith("2/2 queued; I'll show you each application's exact answers on a card before anything is sent."), r!.reply);
  eq(w.kicks, [["greenhouse:a:1", "greenhouse:d:4"]]);
  assert(/I've started preparing them now/.test(r!.reply), r!.reply);
  eq([r!.coverage, r!.prepare], [{ queued: 2, total: 2 }, "started"]);
  assert(!/submitted|applied for you/.test(r!.reply), r!.reply);
});

Deno.test("F01 'apply to all of them': each refusal named with its reason (closed on file, this exact posting already applied to), the fraction says how many; another posting at an employer applied to 4 days ago is queued", async () => {
  const w = world({ kick: "off" });
  const r = await w.turn("apply to all of them");
  eq(r?.status, "queued", r?.reply);
  eq(await w.keys(), ["greenhouse:a:1", "greenhouse:d:4"]);
  assert(r!.reply.startsWith("2/4 queued;"), r!.reply);
  assert(/TEST Analyst at Bravo Labs: posting closed/.test(r!.reply), r!.reply);
  assert(/Data Analyst at Charlie Data: [^\n]*already[^\n]*same posting/.test(r!.reply) && !/30 days/.test(r!.reply), r!.reply);
  assert(/Preparing them hasn't started yet; they wait in your queue\./.test(r!.reply), `off is said, never "started": ${r!.reply}`);
  const again = await w.turn("apply to 1 and 4");
  assert(again!.reply.startsWith("0/2 queued (2 already in your queue);"), again!.reply);
  eq(w.kicks.length, 1, "nothing new queued, nothing asked to prepare");
});

Deno.test("F01 positions past the list are named, never guessed; a posting with no record and no link is 'posting not found'", async () => {
  const w = world();
  const r = await w.turn("apply to 1 and 9");
  assert(r!.reply.startsWith("1/2 queued;"), r!.reply);
  assert(/#9: not on the list I showed \(I listed 4\)/.test(r!.reply), r!.reply);
  const none = await w.turn("apply to 7 and 9");
  eq(none?.status, "none");
  assert(/I listed 4, so there is no #7 or #9/.test(none!.reply) && /nothing was queued/.test(none!.reply), none!.reply);
  const gone = world({ shortlist: [{ id: "greenhouse:z:9", title: "Analyst", company: "Zulu Gone", url: null }] });
  const g = await gone.turn("apply to these");
  assert(/0\/1 queued\./.test(g!.reply) && /Analyst at Zulu Gone: posting not found/.test(g!.reply), g!.reply);
  eq(await gone.keys(), []);
});

Deno.test("F01 no resume on file: nothing queued, every posting named, what to do said; an unreadable check queues nothing either", async () => {
  const w = world({ resume: false });
  const r = await w.turn("apply to 1 and 4");
  eq(r?.status, "no_resume");
  assert(r!.reply.startsWith("0/2 queued."), r!.reply);
  assert(/TEST Analyst at Alpha Works: no resume on file/.test(r!.reply) && /Data Analyst at Delta Freight: no resume on file/.test(r!.reply), r!.reply);
  assert(/Paste or attach your resume, confirm it, then ask again\./.test(r!.reply), r!.reply);
  eq([await w.keys(), w.kicks], [[], []]);
  const single = world({ resume: false, postings: [ON_FILE["greenhouse:a:1"]] });
  const s = await single.turn("apply to the TEST Analyst role at Alpha Works");
  eq(s?.status, "no_resume", s?.reply);
  assert(s!.reply.startsWith("0/1 queued.") && /no resume on file/.test(s!.reply), s!.reply);
  // Fail closed (review of PR #194, under the owner's resume rule): a resume check that cannot be made queues nothing.
  const unknown = world({ resume: null });
  const u = await unknown.turn("apply to the first one");
  eq(u?.status, "resume_unreadable", u?.reply);
  assert(/couldn't check your resume on file just now, so nothing was queued/.test(u!.reply), u!.reply);
  eq([await unknown.keys(), unknown.kicks], [[], []]);
});

// OWNER RULE (2026-10-26, "never submit applications without a real resume"): this test pinned PR #175's behavior (with
// the server prepare off, the want was queued without a resume). The owner's written rule supersedes it: nothing is
// queued without a confirmed resume, prepare on or off. Same worlds, same asks; the expectations are the rule's.
Deno.test("F01 no resume on file with the server prepare off: nothing queued either (owner rule 2026-10-26), nothing asked to prepare, the reply says what to do", async () => {
  const w = world({ resume: false, prepareOn: false, kick: "off" });
  const r = await w.turn("apply to 1 and 4");
  eq(r?.status, "no_resume", r?.reply);
  assert(r!.reply.startsWith("0/2 queued."), r!.reply);
  assert(/Paste or attach your resume, confirm it, then ask again\./.test(r!.reply), r!.reply);
  assert(!/started preparing/.test(r!.reply), r!.reply);
  eq([await w.keys(), w.kicks], [[], []]);
  const single = world({ resume: false, prepareOn: false, postings: [ON_FILE["greenhouse:a:1"]] });
  const s = await single.turn("apply to the TEST Analyst role at Alpha Works");
  eq(s?.status, "no_resume", s?.reply);
  assert(/no resume on file/.test(s!.reply) && !/started preparing/.test(s!.reply), s!.reply);
  eq([await single.keys(), single.kicks], [[], []]);
  const on = world({ resume: false, prepareOn: true });
  eq((await on.turn("apply to 1 and 4"))?.status, "no_resume", "with the prepare on, nothing is queued without a resume");
  eq([await on.keys(), on.kicks], [[], []]);
});

Deno.test("F01 the single named ask: 1/1 queued, the prepare asked for it, the card promise kept", async () => {
  const w = world({ postings: [ON_FILE["greenhouse:d:4"]] });
  const r = await w.turn("apply to the Data Analyst role at Delta Freight");
  eq(r?.status, "queued", r?.reply);
  assert(r!.reply.startsWith("1/1 queued; I'll show you each application's exact answers on a card before anything is sent. Queued: Data Analyst at Delta Freight"), r!.reply);
  assert(/I've started preparing it now/.test(r!.reply) && /the card that shows it exactly/.test(r!.reply), r!.reply);
  eq(w.kicks, [["greenhouse:d:4"]]);
});

Deno.test("F01 the store's own refusal (the database's 30-day rule) is a named refusal, never 'already' and never queued", async () => {
  const inner = memoryWantStore();
  const store: WantStore = { ...inner, put: async (u, items) => ({ added: [], already: [], refused: items.map((w) => ({ posting_key: w.posting_key, reason: "company_cooldown" })) }) };
  const r = await queueWants(store, "u1", [{ job_id: "greenhouse:a:1", url: "https://boards.greenhouse.io/a/jobs/1", company: "Alpha Works", title: "TEST Analyst" }], NOW);
  eq([r.queued, r.already, r.refused.length], [0, 0, 1]);
  assert(/already applied to Alpha Works in the last 30 days/.test(r.refused[0].reason), r.refused[0].reason);
});

Deno.test("F01 checkListed: closed refused, missing with no link refused, missing with a link kept, a failed read decides nothing", async () => {
  const r = await checkListed([
    { job_id: "x", company: "X", title: "T" }, { job_id: "y", company: "Y", title: "T", url: "https://boards.greenhouse.io/y/jobs/1" },
    { job_id: "greenhouse:b:2", company: "Bravo Labs", title: "TEST Analyst" }, { job_id: "boom", company: "Boom", title: "T" },
  ], async (id) => { if (id === "boom") throw new Error("down"); return ON_FILE[id] ?? null; });
  eq(r.ok.map((p) => p.job_id), ["y", "boom"]);
  eq(r.refused.map((x) => [x.job_id, x.reason.split(":")[0]]), [["x", "posting not found"], ["greenhouse:b:2", "posting closed"]]);
});

Deno.test("F01 hasConfirmedResume: only an entry the person confirmed with its recorded event counts", () => {
  eq(hasConfirmedResume(null), false);
  eq(hasConfirmedResume({ facts: [{ status: "draft", needs_confirmation: true }] }), false);
  eq(hasConfirmedResume({ facts: [{ status: "confirmed", needs_confirmation: false }] }), false, "a confirm with no event evidences nothing");
  eq(hasConfirmedResume({ facts: [{ status: "confirmed", needs_confirmation: false, confirmation_event_id: "e1" }] }), true);
});

Deno.test("F01 kickPrepare: off without the owner's URL and token; a 202 is started; an error or other status is failed; the body names exactly the rows", async () => {
  const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  const seen: { url: string; auth: string | null; body: any }[] = [];
  const fake = (status: number) => (async (url: any, init: any) => { seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) }); return new Response("{}", { status }); }) as typeof fetch;
  eq(await kickPrepare({ env: env({}), fetch: fake(202), userId: "u1", jobIds: ["a"] }), "off");
  eq(seen.length, 0, "off sends nothing");
  const on = env({ CAREER_PREPARE_AHEAD_URL: "https://worker.test/prepare", CAREER_PREPARE_AHEAD_TOKEN: "t0k" });
  eq(await kickPrepare({ env: on, fetch: fake(202), userId: "u1", jobIds: ["a", "b"] }), "started");
  eq(seen[0], { url: "https://worker.test/prepare", auth: "Bearer t0k", body: { user_id: "u1", job_ids: ["a", "b"] } });
  eq(await kickPrepare({ env: on, fetch: fake(500), userId: "u1", jobIds: ["a"] }), "failed");
  eq(await kickPrepare({ env: on, fetch: (async () => { throw new Error("down"); }) as typeof fetch, userId: "u1", jobIds: ["a"] }), "failed");
  eq(coverageLine(0, 3), "0/3 queued.");
});

Deno.test("F01 the worker's door: only the token, only a person and rows; 202 at once; runs chained; prepareAhead narrowed to exactly those rows", async () => {
  const runs: any[] = [];
  const door = prepareDoor({ token: "t0k", run: async (only) => { runs.push(only); } });
  const U = "7b0f8f8e-6a43-4a49-9d2c-0000000000e2";
  const post = (auth: string | null, body: unknown) => door(new Request("http://w/", { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) }));
  eq((await post(null, { user_id: U, job_ids: ["a"] })).status, 401);
  eq((await post("Bearer nope", { user_id: U, job_ids: ["a"] })).status, 401);
  eq((await post("Bearer t0k", { user_id: "x", job_ids: ["a"] })).status, 400);
  eq((await post("Bearer t0k", { user_id: U, job_ids: [] })).status, 400);
  eq((await door(new Request("http://w/", { method: "GET" }))).status, 405);
  eq((await post("Bearer t0k", { user_id: U, job_ids: ["a", "b"] })).status, 202);
  await new Promise((r) => setTimeout(r, 0));
  eq(runs, [{ user_id: U, job_ids: ["a", "b"] }]);
  // prepareAhead with `only`: the database's candidates, narrowed; here no resume can be tailored, so the one row is no_resume.
  const cands = [
    { user_id: U, job_id: "a", company: "A", title: "T", url: "https://boards.greenhouse.io/a/jobs/1", location: "", description: "", epoch: 0, version: 0 },
    { user_id: U, job_id: "z", company: "Z", title: "T", url: "https://boards.greenhouse.io/z/jobs/1", location: "", description: "", epoch: 0, version: 0 },
    { user_id: "someone-else", job_id: "a", company: "A", title: "T", url: "https://boards.greenhouse.io/a/jobs/1", location: "", description: "", epoch: 0, version: 0 },
  ];
  const calls: string[] = [];
  const db = { rpc: async (name: string) => { calls.push(name); return name === "career_apply_prepare_candidates" ? { data: cands, error: null } : name === "career_apply_answers_for" ? { data: [], error: null } : { data: null, error: null }; } };
  const out = await prepareAhead({ db, runEngine: async () => { throw new Error("never run"); }, resumeFor: async () => null }, { only: { user_id: U, job_ids: ["a"] } });
  eq(out.map((x) => [x.user_id, x.job_id, x.outcome]), [[U, "a", "no_resume"]]);
});

Deno.test("F01 answer capture: a chat answer the router's batch recorded goes on the person's matching open queue question, checked against its choices", async () => {
  const LABEL = "Will you now or in the future require sponsorship for employment visa status?";
  const run = { apps: { k1: { company: "Alpha Works", stop: { questions: [{ question_key: "sponsorship", label: LABEL }] }, answers: {} } } };
  const before = { answers: {} };
  const after = { answers: { sponsorship: { value: "no", confirmed: true, source: "chat_answer", provenance: `stated in chat as the answer to "${LABEL}" for the Alpha Works application (batch r1)` } } };
  const got = chatAnswersRecorded({ before, after, runBefore: run, runAfter: run });
  eq(got, [{ key: "sponsorship", label: LABEL, value: "no", company: null, scope: "profile" }]);
  eq(chatAnswersRecorded({ before: after, after, runBefore: run, runAfter: run }), [], "an answer already there before the turn is not new");
  const qs: OpenQuestion[] = [
    { id: "q1", key: "fact:sponsorship", kind: "fact", label: LABEL, type: "select", options: ["Yes", "No"], company: null, job_ids: ["e1"], misfit: false, answer: null },
    { id: "q2", key: "job:0123456789abcdef", kind: "essay", label: LABEL, type: "textarea", options: [], company: "Alpha Works", job_ids: ["e1"], misfit: false, answer: null },
    { id: "q3", key: "fact:phone", kind: "fact", label: "Phone", type: "input_text", options: [], company: null, job_ids: ["e1"], misfit: false, answer: null },
  ];
  const saved: [string, string][] = [];
  const store: QueueAnswerStore = { open: async () => qs, answer: async (_u, id, text) => { saved.push([id, text]); } };
  const r = await recordChatAnswers({ userId: "u1", answers: got, store });
  eq(saved, [["q1", "No"]], "the shared question only, as the form's own choice; a posting-bound question is not answered by a profile answer");
  eq(r.recorded.length, 1);
  const misfit = await recordChatAnswers({ userId: "u1", answers: [{ ...got[0], value: "maybe later" }], store });
  eq([misfit.recorded.length, misfit.misfit], [0, [LABEL]], "an answer that fits no choice is left open");
});
