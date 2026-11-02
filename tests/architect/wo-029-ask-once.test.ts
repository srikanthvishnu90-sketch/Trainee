// Ask once (owner target, v2: "every unknown question asked to the user exactly once over iMessage, then never again").
// The questions that stopped a preparation are stored with a key that says how far an answer may go, asked by text a few
// at a time, answered by number, checked by code against the employer's own choices, and read back by the next
// preparation as the person's confirmed facts. The database half is proven in tests/db/career_apply_questions.test.sql.
import { answerKey, mapQuestion } from "../../supabase/functions/_shared/question_map.ts";
import {
  checkAnswer,
  isAsk,
  type OpenQuestion,
  type QuestionStore,
  QUESTIONS_INTENT,
  questionsText,
  questionsTurn,
  splitAnswers,
} from "../../supabase/functions/_shared/career_apply_questions.ts";
import { planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { summarizePipeline, personBlock } from "../../supabase/functions/_shared/agent/memory.ts";
import { factsWithTextAnswers, questionsToStore } from "../../workers/career-browser/approve-first.ts";
import HANDLER from "../../supabase/functions/agent-chat/handler-career.ts" with { type: "text" };
import APPROVE from "../../workers/career-browser/approve-first.ts" with { type: "text" };

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const YN = [{ label: "Yes" }, { label: "No" }];
const T = Date.UTC(2026, 9, 20, 15);

Deno.test("WO-029/1 how far an answer travels: a fact once for every employer; a statement by its wording; an essay or a job's own question for that posting", () => {
  const spons = { label: "Will you now or in the future require visa sponsorship?", type: "select", options: YN };
  eq(answerKey(spons, "gh:a"), "fact:sponsorship");
  eq(answerKey(spons, "gh:b"), "fact:sponsorship", "the same fact from another employer");
  assert(answerKey(spons, "gh:a", { haveFact: true }).startsWith("job:"), "a stated fact that did not fit this form is asked for this posting only");
  // A yes to "a U.S. citizen?" is not a citizenship; a yes to "authorized in the US?" must never answer it for Canada.
  const citizen = { label: "Are you a U.S. citizen?", type: "select", options: YN };
  eq(mapQuestion(citizen).fact, "citizenship");
  assert(answerKey(citizen, "gh:a").startsWith("label:"), "a yes/no question about a fact that is not a yes or no is kept to its wording");
  const us = answerKey({ label: "Are you legally authorized to work in the United States?", type: "select", options: YN }, "gh:a");
  const ca = answerKey({ label: "Are you legally authorized to work in Canada?", type: "select", options: YN }, "gh:a");
  assert(us.startsWith("label:") && us !== ca, "US and Canada authorization are two questions");
  eq(answerKey({ label: "Country of citizenship", type: "select", options: [{ label: "United States" }, { label: "Canada" }] }, "gh:a"), "fact:citizenship");
  const felony = { label: "Have you been convicted of a felony in the last 7 years?", type: "select", options: YN };
  eq(answerKey(felony, "gh:a"), answerKey(felony, "gh:b"), "a legal statement: the same wording anywhere");
  assert(answerKey(felony, "gh:a") !== answerKey({ ...felony, label: "Have you ever been convicted of a felony?" }, "gh:a"), "never another wording");
  const why = { label: "Why do you want to work here?", type: "textarea" };
  assert(answerKey(why, "gh:a").startsWith("job:") && answerKey(why, "gh:a") !== answerKey(why, "gh:b"), "'why us' is never reused for another employer");
  const office = { label: "Can you work from our Denver office 5 days a week?", type: "select", options: YN };
  assert(answerKey(office, "gh:a") !== answerKey(office, "gh:b"), "a question about this job's office is this posting's");
  const tool = { label: "How many years of experience do you have with Snowflake?", type: "text" };
  eq(answerKey(tool, "gh:a"), answerKey(tool, "gh:b"), "years with a named tool is about the person: by its wording");
  assert(/^(fact:[a-z0-9_]+|(label|job):[0-9a-f]{16})$/.test(answerKey({ label: "どうやって知りましたか？", type: "text" }, "x")), "any language makes a valid key");
});

const q = (o: Partial<OpenQuestion>): OpenQuestion => ({
  id: "q1", key: "label:0000000000000001", kind: "unknown", label: "Question?", type: "input_text", options: [], company: null, job_ids: ["gh:a"],
  misfit: false, answer: null, ...o,
});

Deno.test("WO-029/2 an answer is the employer's own choice or the person's own words; nothing is derived or forced", () => {
  const spons = q({ key: "fact:sponsorship", kind: "fact", label: "Will you require sponsorship?", type: "select", options: ["Yes, I will", "No, I will not"] });
  eq(checkAnswer(spons, "nope"), { ok: true, value: "No" }, "a fact for every employer is kept as a plain yes or no");
  eq(checkAnswer(spons, "No, I will not"), { ok: true, value: "No" });
  const citizen = q({ key: "label:00000000000000aa", kind: "fact", label: "Are you a U.S. citizen?", type: "select", options: ["Yes", "No"] });
  eq(checkAnswer(citizen, "yes"), { ok: true, value: "Yes" }, "a yes is a yes: never turned into a no because 'yes' is not a country");
  eq(checkAnswer(citizen, "yep"), { ok: true, value: "Yes" }, "nor a 'yep' (the option is chosen from the answer, never derived from the question)");
  eq(checkAnswer({ ...citizen, options: ["Yes, I am a U.S. citizen", "No"] }, "I am"), { ok: true, value: "Yes, I am a U.S. citizen" });
  const edu = q({ key: "fact:education_level", kind: "fact", label: "Highest degree", type: "select", options: ["High school", "Bachelor's Degree", "Master's Degree"] });
  eq(checkAnswer(edu, "bachelors"), { ok: true, value: "Bachelor's Degree" }, "a value fact is kept as the employer's option");
  const bad = checkAnswer(edu, "I went to college for a while");
  assert(!bad.ok && /High school \/ Bachelor's Degree \/ Master's Degree/.test(bad.why), "an answer that fits no choice is said back with the choices");
  const notice = q({ key: "job:00000000000000bb", kind: "fact", label: "Notice period", type: "select", options: ["1-2 weeks", "2-4 weeks", "1 month+"] });
  eq(checkAnswer(notice, "2 weeks").ok, false, "2 weeks sits on two choices' edge: asked again, never guessed");
  eq(checkAnswer(notice, "10 days"), { ok: true, value: "1-2 weeks" });
  eq(checkAnswer(q({ type: "checkbox", kind: "consent", label: "I agree to the privacy notice" }), "sure"), { ok: true, value: "Yes" });
  eq(checkAnswer(q({ type: "checkbox", kind: "consent" }), "maybe").ok, false, "a consent takes a yes or a no");
  const essay = q({ kind: "essay", type: "textarea", label: "Why us?" });
  eq(checkAnswer(essay, "  Because I built  payments at scale. "), { ok: true, value: "Because I built payments at scale." }, "an essay is the person's own words");
  const removed = checkAnswer(q({ label: "Anything else?" }), "my ssn is [SSN removed]");
  assert(!removed.ok && /never keeps/.test(removed.why), "an answer whose number the chat input removed is never saved");
  assert(!checkAnswer(q({}), "skip").ok && (checkAnswer(q({}), "skip") as any).skip, "skip leaves it open");
  eq(checkAnswer(q({}), "x".repeat(2001)).ok, false, "at most 2,000 characters");
});

Deno.test("WO-029/3 which number answers what: in order, up to how many were shown, never a number with a unit", () => {
  eq([...splitAnswers("1 no 2 2 weeks", 2)!], [[1, "no"], [2, "2 weeks"]]);
  eq([...splitAnswers("1 I have 3 years 2 no", 2)!], [[1, "I have 3 years"], [2, "no"]]);
  eq([...splitAnswers("1. yes\n2) because I love payments\n3 - no", 3)!], [[1, "yes"], [2, "because I love payments"], [3, "no"]]);
  eq([...splitAnswers("1 yes, 3 no", 3)!], [[1, "yes"], [3, "no"]], "a question left out stays open");
  eq([...splitAnswers("because I love it", 1)!], [[1, "because I love it"]], "one question shown: the whole text answers it");
  eq([...splitAnswers("1 because I love it", 1)!], [[1, "because I love it"]]);
  eq(splitAnswers("no", 2), null, "two shown and no number: not an answer");
  eq(splitAnswers("4 yes", 3), null, "a number not shown is not an answer");
});

function fakeStore(rows: OpenQuestion[], intent: string | null = null) {
  const kv: Record<string, any> = {};
  const answers: [string, string][] = [];
  let last = intent;
  const store: QuestionStore & { answers: typeof answers; setIntent(i: string | null): void } = {
    answers,
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = rows.find((x) => x.id === id)!; r.answer = a; r.misfit = false; answers.push([id, a]); },
    async shown() { return kv.shown ?? null; },
    async setShown(_u, s) { kv.shown = s; },
    async lastAssistantIntent() { return last; },
  };
  return store;
}

Deno.test("WO-029/4 'what do you need from me' asks them, numbered, with the choices and the employer when it is one job's", async () => {
  for (const t of ["what do you need from me?", "What else do you need", "any questions for me", "show my questions", "what's blocking my applications"]) assert(isAsk(t), t);
  for (const t of ["what do you need to apply to stripe", "I need a job", "questions about salary"]) assert(!isAsk(t), t);
  const rows = [
    q({ id: "a", key: "fact:sponsorship", kind: "fact", label: "Will you require sponsorship?", type: "select", options: ["Yes", "No"] }),
    q({ id: "b", key: "job:00000000000000cc", kind: "essay", label: "Why do you want to work at Ramp?", type: "textarea", company: "Ramp" }),
    q({ id: "c", key: "label:00000000000000dd", kind: "unknown", label: "Passport number", type: "text" }),
  ];
  // One question per message (coordinator review of #360, 2026-10-31): the first open one, with its choices; the employer
  // when it is one job's is shown when that question's turn comes.
  const store = fakeStore(rows);
  const r = await questionsTurn({ message: "what do you need from me", userId: "u", threadId: "t", now: T, store });
  eq(r!.status, "shown");
  assert(r!.reply.includes("Will you require sponsorship? (Yes / No)"), r!.reply);
  assert(!r!.reply.includes("Why do you want to work at Ramp?"), `one question only: ${r!.reply}`);
  assert(/Question 1 of 2 /.test(r!.reply), `counts what it will ask, never the passport: ${r!.reply}`);
  assert(!/passport/i.test(r!.reply), "an identity number is never asked by text");
  assert(/Answer it once and I won't ask again/.test(r!.reply) && /Just reply with your answer/.test(r!.reply) && !/"1 no 2 3 years"/.test(r!.reply));
  eq((await store.shown("u"))!.ids, ["a"]);
  store.setIntent(QUESTIONS_INTENT);
  const next = await questionsTurn({ message: "no", userId: "u", threadId: "t", now: T, store });
  eq(next!.status, "answered_next");
  assert(next!.reply.includes("Why do you want to work at Ramp? For Ramp. (in your own words"), next!.reply);
  eq((await store.shown("u"))!.ids, ["b"]);
  const none = await questionsTurn({ message: "what do you need from me", userId: "u", threadId: "t", now: T, store: fakeStore([]) });
  assert(/Nothing is waiting on you/.test(none!.reply));
  const many = Array.from({ length: 9 }, (_, i) => q({ id: `m${i}`, label: `Question number ${i} about something?` }));
  const t = questionsText(many, 9)!;
  eq(t.take.length, 1, "one a text");
  assert(t.text.includes("Question 1 of 9") && t.text.includes("I'll ask the next one after you answer this."), t.text);
  const long = Array.from({ length: 3 }, (_, i) => q({ id: `l${i}`, label: `${"Long question words ".repeat(40)}${i}?` }));
  eq(questionsText(long, 3)!.take.length, 1, "a long question is never cut");
});

Deno.test("WO-029/5 the next text answers them by number while they are the thread's last word; a wrong fit is said back and stays open", async () => {
  const rows = [
    q({ id: "a", key: "fact:sponsorship", kind: "fact", label: "Will you require sponsorship?", type: "select", options: ["Yes", "No"] }),
    q({ id: "b", key: "job:00000000000000cc", kind: "essay", label: "Why do you want to work at Ramp?", type: "textarea", company: "Ramp" }),
    q({ id: "c", key: "fact:education_level", kind: "fact", label: "Highest degree", type: "select", options: ["Bachelor's", "Master's"] }),
  ];
  const store = fakeStore(rows);
  await questionsTurn({ message: "what do you need from me", userId: "u", threadId: "t", now: T, store });
  store.setIntent("career_brain");
  eq(await questionsTurn({ message: "1 no", userId: "u", threadId: "t", now: T, store }), null, "not the last word: not an answer");
  store.setIntent(QUESTIONS_INTENT);
  eq(await questionsTurn({ message: "1 no", userId: "u", threadId: "other", now: T, store }), null, "another thread's questions are not answered here");
  // One at a time: each answer is the shown question's; the next is asked in the same reply.
  const r = await questionsTurn({ message: "nope", userId: "u", threadId: "t", now: T, store });
  eq(r!.status, "answered_next", r!.reply);
  assert(/^Saved\. I won't ask this again:/.test(r!.reply) && r!.reply.includes("Why do you want to work at Ramp?"), r!.reply);
  const essay = await questionsTurn({ message: "I've built card issuing twice and want to do it at scale", userId: "u", threadId: "t", now: T, store });
  eq(essay!.status, "answered_next", essay!.reply);
  eq(store.answers, [["a", "No"], ["b", "I've built card issuing twice and want to do it at scale"]]);
  const wrong = await questionsTurn({ message: "a phd", userId: "u", threadId: "t", now: T, store });
  eq(wrong!.status, "partial");
  assert(wrong!.reply.includes("Still open:\n1 needs one of: Bachelor's / Master's."), wrong!.reply);
  const again = await questionsTurn({ message: "masters", userId: "u", threadId: "t", now: T + 60000, store });
  eq(again!.status, "answered");
  eq(store.answers.at(-1), ["c", "Master's"]);
  const late = await questionsTurn({ message: "yes", userId: "u", threadId: "t", now: T + 25 * 3600000, store });
  eq(late!.status, "expired", "a day later nothing is saved");
  // One question shown: talk is not an answer.
  const one = fakeStore([q({ id: "z", kind: "essay", type: "textarea", label: "Tell us about yourself" })]);
  await questionsTurn({ message: "what do you need from me", userId: "u", threadId: "t", now: T, store: one });
  one.setIntent(QUESTIONS_INTENT);
  eq(await questionsTurn({ message: "can you find me jobs in Denver?", userId: "u", threadId: "t", now: T, store: one }), null);
  eq((await questionsTurn({ message: "I lead data teams and love messy problems", userId: "u", threadId: "t", now: T, store: one }))!.status, "answered");
});

const field = (label: string, type = "input_text", options: string[] = []) => ({
  name: label.toLowerCase().replace(/\W+/g, "_"), label, required: true, type, options: options.map((l) => ({ label: l, value: l })),
});

Deno.test("WO-029/6 the loop: a form stops, its questions are stored, answered by text, and the next preparation fills them", async () => {
  const facts = { user_id: "TEST", answers: { first_name: { value: "Test", factId: "f1", confirmed: true } }, saved: {} };
  const form = [
    field("First name"),
    field("Will you now or in the future require sponsorship?", "multi_value_single_select", ["Yes", "No"]),
    field("Why do you want to work at Ramp?", "textarea"),
    field("Passport number"),
  ];
  const result = {
    state: "not_submitted", reason: "needs_answers", posting: "ashby:ramp:1", company: "Ramp",
    questions: form.slice(1).map((f) => ({ label: f.label, type: f.type, options: f.options.map((o) => o.label) })),
  };
  const stored = questionsToStore(result, { facts: facts.answers, answered: new Set() });
  eq(stored.posting, "ashby:ramp:1");
  eq(stored.questions.map((x) => x.key), ["fact:sponsorship", answerKey({ label: form[2].label, type: "textarea" }, "ashby:ramp:1")]);
  assert(!JSON.stringify(stored).includes("Passport"), "an identity number never leaves the person's computer as a question");
  eq(stored.questions[1].company, "Ramp");
  // Asked and answered by text (the rows the database would hold).
  const rows = stored.questions.map((x, i) => q({ id: `r${i}`, key: x.key as string, kind: x.kind as string, label: x.label as string, type: x.type as string, options: x.options as string[], company: "Ramp" }));
  const store = fakeStore(rows);
  await questionsTurn({ message: "what do you need from me", userId: "TEST", threadId: "t", now: T, store });
  store.setIntent(QUESTIONS_INTENT);
  await questionsTurn({ message: "no", userId: "TEST", threadId: "t", now: T, store });
  await questionsTurn({ message: "Ramp's spend tools are what I wished I had as a controller", userId: "TEST", threadId: "t", now: T, store });
  const merged = factsWithTextAnswers(facts, rows.map((r) => ({ id: r.id, key: r.key, kind: r.kind, answer: r.answer! })));
  const plan = (job: string, fields: any[]) =>
    planBatch({ userId: "TEST", postings: [{ job_id: job, company: "Ramp", title: "", fields }], answers: merged.answers as any, saved: merged.saved as any, log: [], now: T });
  const p = plan("ashby:ramp:1", form.slice(0, 3));
  eq(p.needs, [], "nothing left to ask");
  const filled = Object.fromEntries(p.ready[0].fields.map((f) => [f.label, [f.value, f.factId]]));
  eq(filled["Will you now or in the future require sponsorship?"], ["No", "text-answer:r0"]);
  eq(filled["Why do you want to work at Ramp?"], ["Ramp's spend tools are what I wished I had as a controller", "text-answer:r1"]);
  // Another employer: the fact goes there too; the essay never does.
  const other = plan("ashby:brex:9", [field("Do you require sponsorship?", "multi_value_single_select", ["Yes", "No"]), field("Why do you want to work at Ramp?", "textarea")]);
  eq(other.needs.map((n) => n.label), ["Why do you want to work at Ramp?"], "an essay answered for one posting is asked again for another");
  // The person's own facts file wins over a texted fact; an answered key seen again is marked misfit.
  eq((factsWithTextAnswers({ answers: { sponsorship: { value: "Yes", factId: "own", confirmed: true } } }, [{ id: "x", key: "fact:sponsorship", kind: "fact", answer: "No" }]) as any).answers.sponsorship.factId, "own");
  eq(questionsToStore(result, { facts: facts.answers, answered: new Set(["fact:sponsorship"]) }).questions[0].misfit, true);
  // A stated fact that did not fit is asked for this posting only.
  assert(String(questionsToStore(result, { facts: { ...facts.answers, sponsorship: {} }, answered: new Set() }).questions[0].key).startsWith("job:"));
});

Deno.test("WO-029/7 wired: the handler asks before any brain, prepare-batch reads answers back and stores questions, Trainee knows how many wait", () => {
  const card = HANDLER.indexOf("await cardTurn("), ask = HANDLER.indexOf("await questionsTurn("), brain = HANDLER.indexOf("await agentTurn(");
  assert(card > 0 && ask > card && brain > ask, "cards, then questions, then the brain");
  assert(/QUESTIONS_INTENT : "career_apply_questions_answer"/.test(HANDLER));
  assert(APPROVE.includes('client.rpc("career_apply_answers_own")') && APPROVE.includes('client.rpc("career_apply_questions_put_own"'));
  assert(/Deno\.remove\(factsDir, \{ recursive: true \}\)/.test(APPROVE), "the merged facts file is removed when the batch ends");
  const pipe = summarizePipeline({ prepared: [], openCard: null, jobs: [], openQuestions: 3 }, T);
  eq(pipe.questions, 3);
  const block = personBlock({ standing: [], profile: {}, alerts: null, pipeline: pipe } as any);
  assert(/Questions only they can answer, holding up applications: 3 \(texting "what do you need from me" shows them; never answer one for them\)/.test(block), block);
  const unread = personBlock({ standing: [], profile: {}, alerts: null, pipeline: summarizePipeline({ prepared: [], openCard: null, jobs: [], openQuestions: null }, T) } as any);
  assert(/Questions only they can answer: could not be read this turn/.test(unread));
});

Deno.test("WO-029/8 every turn reads one key first: nothing showing reads nothing else, and a failed read never fails the person's message", async () => {
  let intents = 0;
  const store = fakeStore([]);
  const counted = { ...store, lastAssistantIntent: async (t: string) => { intents++; return store.lastAssistantIntent(t); } };
  eq(await questionsTurn({ message: "1 yes", userId: "u", threadId: "t", now: T, store: counted }), null);
  eq(intents, 0, "no questions showing: the thread's last reply is not read");
  const broken = { ...store, shown: () => Promise.reject(new Error("read failed")) };
  eq(await questionsTurn({ message: "find me analyst jobs", userId: "u", threadId: "t", now: T, store: broken }), null, "the turn goes on without this");
});
