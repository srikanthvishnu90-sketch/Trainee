// WO-030: essays drafted from confirmed facts, offered inside ask once. "draft 2" drafts a written answer, shows it whole,
// and only "use 2" saves it (through the same check and store.answer as a typed answer). The employer's own AI policy
// decides first; nothing is invented (every checkable item traces to a confirmed fact or the posting); the form's
// length limit is met by writing again, never by cutting; the model is a stub here and a failure never leaves the turn.
// Real wording comes from the captured CI question sets (evals/apply/questions-ci*.json). No model, no network.
import CI_A from "../../evals/apply/questions-ci.json" with { type: "json" };
import CI_B from "../../evals/apply/questions-ci-b.json" with { type: "json" };
import { aiPolicyStatements, readAiPolicy } from "../../supabase/functions/_shared/ai_policy.ts";
import {
  confirmedFacts,
  draftEssay,
  employerGate,
  factLock,
  lengthLimit,
  parseDraftCommand,
} from "../../supabase/functions/_shared/essay_draft.ts";
import {
  type OpenQuestion,
  type QuestionStore,
  QUESTIONS_INTENT,
  questionsText,
  questionsTurn,
  supabaseQuestionStore,
} from "../../supabase/functions/_shared/career_apply_questions.ts";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { callModel, modelConfig } from "../../supabase/functions/_shared/model_gateway.ts";
import { factsWithTextAnswers, questionsToStore } from "../../workers/career-browser/approve-first.ts";
import HANDLER from "../../supabase/functions/agent-chat/handler-career.ts" with { type: "text" };
import APPLY from "../../scripts/apply.ts" with { type: "text" };
import ESSAY_SRC from "../../supabase/functions/_shared/essay_draft.ts" with { type: "text" };
import POLICY_SRC from "../../supabase/functions/_shared/ai_policy.ts" with { type: "text" };

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const T = Date.UTC(2026, 9, 20, 15);
const postingOf = (set: any, company: string) => set.postings.find((p: any) => p.company === company);
const labelsOf = (p: any) => p.fields.map((f: any) => String(f.label));
const CANONICAL = postingOf(CI_A, "Canonical"), ANTHROPIC = postingOf(CI_A, "Anthropic"), AIRWALLEX = postingOf(CI_A, "Airwallex");
const SPRY = postingOf(CI_B, "SpryPoint");
const canonicalBan = labelsOf(CANONICAL).find((l: string) => /only my own words/.test(l))!;
const canonicalEssay = labelsOf(CANONICAL).find((l: string) => /^Describe any publicly listed company experience/.test(l))!;
const anthropicPolicy = labelsOf(ANTHROPIC).find((l: string) => /AI Policy for Application/.test(l))!;
const airwallexAllow = labelsOf(AIRWALLEX).find((l: string) => /We encourage you to use AI tools/.test(l))!;

// ---------------------------------------------------------------------------------------------------------------------
// The person's profile: confirmed facts, a draft still waiting for their yes, a bare skill.
const FACTS = [
  { id: "F-001", kind: "experience", text: "Senior accountant at Brightline Health, 2021 to 2024; closed the monthly books in 5 days instead of 9", needs_confirmation: false, status: "confirmed" },
  { id: "F-002", kind: "project", text: "Built a NetSuite to Snowflake reconciliation in Python that cut manual matching by 40%", needs_confirmation: false, status: "confirmed" },
  { id: "F-003", kind: "education", text: "B.S. Accounting, University of Iowa, 2019", needs_confirmation: false, status: "confirmed" },
  { id: "F-004", kind: "preference", text: "Wants to build finance software used by controllers", needs_confirmation: false, status: "confirmed" },
  { id: "F-005", kind: "experience", text: "Led a team of 12 engineers at Stripe as engineering manager", needs_confirmation: true, status: "draft" },
  { id: "F-006", kind: "skill", name: "Python", text: "Skill: Python", evidence: [] },
];
const CLEAN =
  "At Brightline Health I was the senior accountant who got our monthly close from 9 days to 5. I built a NetSuite to Snowflake reconciliation in Python that cut manual matching by 40%, and I want to build finance software used by controllers. That is why I want to work at Ramp.";
const INVENTED =
  "At Stripe I led a team of 12 engineers as engineering manager and doubled revenue to $2M using Kubernetes. I also hold an MBA from Stanford.";
const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? "controllers" : "books")).join(" ") + ".";

// A model stub: answers in order, records every payload; a thrown Error stands for a provider failure.
function stub(...answers: (string | Error | { text: string; stop: string })[]) {
  const calls: any[] = [];
  const model = async (payload: any) => {
    calls.push(payload);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    const text = typeof a === "string" ? a : a.text;
    return { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: typeof a === "string" ? "end_turn" : a.stop };
  };
  return { model, calls };
}

const q = (o: Partial<OpenQuestion>): OpenQuestion => ({
  id: "q1", key: "label:0000000000000001", kind: "unknown", label: "Question?", type: "input_text", options: [], company: null, job_ids: ["gh:a"],
  misfit: false, answer: null, ...o,
});
const RAMP = (o: Partial<OpenQuestion> = {}) =>
  q({ id: "b", key: "job:00000000000000cc", kind: "essay", label: "Why do you want to work at Ramp?", type: "textarea", company: "Ramp", job_ids: ["ashby:ramp:1"], ...o });
const SPONS = () => q({ id: "a", key: "fact:sponsorship", kind: "fact", label: "Will you require sponsorship?", type: "select", options: ["Yes", "No"], job_ids: ["ashby:ramp:1"] });

function fakeStore(rows: OpenQuestion[], o: { postings?: boolean; extra?: OpenQuestion[] } = {}) {
  const kv: Record<string, any> = {};
  const answers: [string, string][] = [];
  let last: string | null = null;
  const all = () => [...rows, ...(o.extra ?? [])];
  const store: QuestionStore & { answers: typeof answers; setIntent(i: string | null): void; kv: typeof kv } = {
    answers, kv,
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return all().filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = all().find((x) => x.id === id)!; r.answer = a; r.misfit = false; answers.push([id, a]); },
    async shown() { return kv.shown ? JSON.parse(JSON.stringify(kv.shown)) : null; }, // as the database would: a copy
    async setShown(_u, s) { kv.shown = JSON.parse(JSON.stringify(s)); },
    async lastAssistantIntent() { return last; },
  };
  if (o.postings !== false) store.onPostings = async (_u, jobIds) => all().filter((r) => r.job_ids.some((j) => jobIds.includes(j)));
  return store;
}
// The handler's rule: a turn whose status is shown, partial or any draft status leaves the questions as the last word.
const waiting = (s: string) => ["shown", "partial", "answered_next"].includes(s) || s.startsWith("draft");
async function say(store: ReturnType<typeof fakeStore>, message: string, o: { model?: any; facts?: unknown[]; now?: number; thread?: string } = {}) {
  const r = await questionsTurn({
    message, userId: "u", threadId: o.thread ?? "t", now: o.now ?? T, store,
    draft: o.model ? { model: o.model, facts: () => o.facts ?? FACTS } : undefined,
  });
  if (r) store.setIntent(waiting(r.status) ? QUESTIONS_INTENT : "career_apply_questions_answer");
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
Deno.test("WO-030/1 the employer's AI policy is read from the form's own words: the real CI sets give exactly one ban, one unread policy, two allowances", () => {
  const found: Record<string, string> = {};
  for (const set of [CI_A, CI_B] as any[]) {
    for (const p of set.postings) {
      const r = readAiPolicy(labelsOf(p));
      if (r.policy !== "unknown") found[p.company] = r.policy;
    }
  }
  eq(found, { Anthropic: "unread", Canonical: "prohibited", Airwallex: "allowed", SpryPoint: "allowed" }, "200 real postings");
  eq(readAiPolicy([canonicalBan]).said, canonicalBan, "the ban is said in the employer's own words");
  // Airwallex bans AI in live interviews and encourages it for the application: an interview rule is not an application rule.
  const interviewOnly = airwallexAllow.split(". ").find((s: string) => /interviews/.test(s))!;
  eq(readAiPolicy([interviewOnly]).policy, "unknown", "a rule about live interviews is not a rule about the written application");
  eq(readAiPolicy([airwallexAllow]).policy, "allowed");
  // Questions ABOUT AI are not a policy.
  for (const l of ["What are your favourite AI tools/workflows at the moment?", "Would you like to opt out of AI-powered Talent Matching?",
    labelsOf(postingOf(CI_A, "Palantir")).find((l: string) => /AI notetakers/.test(l))]) eq(readAiPolicy([l]).policy, "unknown", String(l));
  // A ban anywhere on the form wins over an allowance elsewhere.
  eq(readAiPolicy([airwallexAllow, canonicalBan]).policy, "prohibited");
  eq(readAiPolicy(["Why us? Please answer in your own words without using ChatGPT or other AI tools."]).policy, "prohibited", "a ban inside the essay label itself");
  // What the person's computer carries from a whole form: only the statements.
  eq(aiPolicyStatements(labelsOf(CANONICAL)), [canonicalBan]);
  eq(aiPolicyStatements(labelsOf(SPRY)).length, 1);
  eq(aiPolicyStatements(labelsOf(postingOf(CI_A, "Prolific"))), []);
});

Deno.test("WO-030/2 the employer's own policy decides first: a form that asks for answers without AI is never drafted for, and the model is never called", async () => {
  // Canonical's real essay and its real ban, the ban stored as an answered question on the same posting.
  const essay = q({ id: "e", key: answerKey({ label: canonicalEssay, type: "textarea" }, CANONICAL.id), kind: "essay", label: canonicalEssay, type: "textarea", company: "Canonical", job_ids: [CANONICAL.id] });
  const ban = q({ id: "p", key: "label:00000000000000ee", kind: "consent", label: canonicalBan, type: "multi_value_single_select", options: ["Yes", "No"], company: "Canonical", job_ids: [CANONICAL.id], answer: "Yes" });
  const store = fakeStore([essay], { extra: [ban] });
  await say(store, "what do you need from me");
  const m = stub(CLEAN);
  const r = await say(store, "draft 1", { model: m.model });
  eq(r!.status, "draft_policy");
  assert(/^Canonical asks for answers written without AI \("During this application process I agree to use only my own words/.test(r!.reply), r!.reply);
  assert(/it needs your own words\. Reply "1" and your own answer/.test(r!.reply), r!.reply);
  eq(m.calls.length, 0, "the model is never called");
  eq(store.answers, [], "nothing saved");
  // The same ban carried with the essay by the person's computer (a standing consent filled the statement, so it was never stored).
  const carried = fakeStore([{ ...essay, ai_policy: canonicalBan }]);
  eq(questionsText(await carried.open("u", 5), 1)!.text.includes("draft"), false, "a banned essay is not offered for drafting");
  await say(carried, "what do you need from me");
  const m2 = stub(CLEAN);
  eq((await say(carried, "write it for me", { model: m2.model }))!.status, "draft_policy");
  eq(m2.calls.length, 0);
  // Anthropic's bare "AI Policy for Application": a policy whose terms the form does not show is not permission.
  const why = q({ id: "w", key: "job:00000000000000a7", kind: "essay", label: "Why Anthropic?", type: "textarea", company: "Anthropic", job_ids: [ANTHROPIC.id] });
  const pol = q({ id: "x", key: "label:00000000000000a8", kind: "unknown", label: anthropicPolicy, type: "multi_value_single_select", options: ["Yes", "No"], job_ids: [ANTHROPIC.id] });
  const st3 = fakeStore([why, pol]);
  await say(st3, "what do you need from me");
  const m3 = stub(CLEAN);
  const r3 = await say(st3, "draft 1", { model: m3.model });
  eq(r3!.status, "draft_policy");
  assert(/^Anthropic's form has its own AI policy for applications \("AI Policy for Application"\) and doesn't show what it allows/.test(r3!.reply), r3!.reply);
  eq(m3.calls.length, 0);
  // gate0 (154) receives the employer's record: a ban is OWNER_WRITE_ONLY from the context, before anything else.
  const g = employerGate({ ...essay, ai_policy: canonicalBan }, []);
  eq([g.policy.policy, g.gate.allowed, g.gate.policy, g.gate.entry], ["prohibited", false, "OWNER_WRITE_ONLY", "context"]);
  // When the posting's other questions cannot be read, nothing is drafted (the policy might be among them).
  const blind = fakeStore([RAMP()], { postings: false });
  await say(blind, "what do you need from me");
  const m4 = stub(CLEAN);
  eq((await say(blind, "draft 1", { model: m4.model }))!.status, "draft_policy");
  eq(m4.calls.length, 0);
});

Deno.test("WO-030/3 never invent (D-007): only confirmed facts and the posting; a draft that does not trace is written again once, then not shown", async () => {
  const sources = [...confirmedFacts(FACTS).map((f) => f.text), "Ramp", "Why do you want to work at Ramp?"];
  eq(factLock(CLEAN, sources), { pass: true, untraced: [] });
  const bad = factLock(INVENTED, sources);
  eq(bad.pass, false);
  const low = bad.untraced.map((u) => u.toLowerCase());
  for (const item of ["stripe", "12", "engineering manager", "doubled", "$2", "2m", "kubernetes", "mba", "stanford"]) {
    assert(low.includes(item), `untraced ${item}: ${bad.untraced.join("; ")}`);
  }
  for (const [text, item] of [["I joined Acme's finance team in March.", "Acme"], ["I wrote the matching in JavaScript.", "JavaScript"], ["I was a director there.", "director"],
    ["I cut matching by 45%.", "45%"], ["I did this in 2018.", "2018"], ["I worked with PostgreSQL daily.", "PostgreSQL"]] as const) {
    assert(factLock(text, sources).untraced.includes(item), `${item} in "${text}"`);
  }
  eq(confirmedFacts(FACTS).map((f) => f.id), ["F-001", "F-002", "F-003", "F-004"], "a draft fact and an unproven skill are never sources");

  // The flow: an invented draft is written again once, with the failing items named; the clean one is shown.
  const store = fakeStore([SPONS(), RAMP()]);
  await say(store, "what do you need from me");
  // One question per message (review of #360): "skip" moves past the sponsorship question to the essay, now question 1.
  await say(store, "skip");
  const m = stub(INVENTED, CLEAN);
  const r = await say(store, "draft 1", { model: m.model });
  eq(r!.status, "drafted");
  eq(m.calls.length, 2);
  const fix = m.calls[1].messages[0].content as string;
  assert(/It named things that are not in the facts: .*Stripe.*Leave them out entirely/.test(fix), fix);
  assert(!(m.calls[0].messages[0].content as string).includes("F-005"), "a fact waiting for their yes is never given to the model");
  assert(r!.reply.includes(CLEAN), "the draft is shown whole");
  eq(store.answers, [], "a draft is never saved on its own");

  // Still invented after the one rewrite: not offered; the reply says what is missing.
  const st2 = fakeStore([SPONS(), RAMP()]);
  await say(st2, "what do you need from me");
  await say(st2, "skip");
  const m2 = stub(INVENTED, INVENTED, CLEAN);
  const r2 = await say(st2, "draft 1", { model: m2.model });
  eq(r2!.status, "draft_unverified");
  eq(m2.calls.length, 2, "regenerated at most once");
  assert(/^I didn't show a draft for 1: it kept including things you haven't confirmed \(.*Stripe.*\)/.test(r2!.reply), r2!.reply);
  assert(!r2!.reply.includes(INVENTED), "the failing draft is never shown");
  eq((await st2.shown("u"))!.drafts ?? {}, {}, "nothing is kept to use");
  eq((await say(st2, "use 1"))!.status, "draft_none", "so there is nothing to use");
  eq(st2.answers, []);

  // Fewer than 2 confirmed facts that fit: no draft, and it says which facts would let it draft.
  const thin = [FACTS[0], FACTS[4], FACTS[5]];
  const st3 = fakeStore([RAMP({ label: "Describe a project you're proud of." })]);
  await say(st3, "what do you need from me");
  const m3 = stub(CLEAN);
  const r3 = await say(st3, "draft 1", { model: m3.model, facts: thin });
  eq(r3!.status, "draft_thin");
  assert(/only 1 of your confirmed facts fit it, and I need at least 2 so nothing is made up\. Tell me a project you led or a job you held, with what it achieved/.test(r3!.reply), r3!.reply);
  eq(m3.calls.length, 0);
});

Deno.test("WO-030/4 the form's length limit is met by writing again, never by cutting; a reply cut off mid-sentence is never shown", async () => {
  eq(lengthLimit("Why do you want to work at Ramp? (150 words max)"), { words: 150, chars: 2000, sentences: null, stated: true });
  eq(lengthLimit("Tell us about a project in 100 words or less."), { words: 100, chars: 2000, sentences: null, stated: true });
  eq(lengthLimit("Describe your experience (max 500 characters)").chars, 500);
  eq(lengthLimit("Explain in 1-3 sentences.").sentences, 3);
  eq(lengthLimit("Why us?"), { words: 250, chars: 2000, sentences: null, stated: false }, "no stated limit: 250 words, never past what one answer holds");

  const label = "Why do you want to work at Ramp? (in 60 words or less)";
  const long = `${CLEAN} ${words(40)}`; // traces, but about 90 words
  const store = fakeStore([RAMP({ label })]);
  await say(store, "what do you need from me");
  const m = stub(long, CLEAN);
  const r = await say(store, "draft 1", { model: m.model });
  eq(r!.status, "drafted");
  assert(/It was too long: it was \d+ words and the limit is 60\. Write a shorter answer; never cut a sentence off\./.test(m.calls[1].messages[0].content), m.calls[1].messages[0].content);
  assert(m.calls[0].messages[0].content.includes("Length: at most 60 words"), "the limit is given to the model");
  assert(r!.reply.includes(`\n\n${CLEAN}\n\n`), "the shorter draft, whole");
  const kept = (await store.shown("u"))!.drafts!.b.text;
  eq(kept, CLEAN, "what is kept to use is exactly what was shown");

  const st2 = fakeStore([RAMP({ label })]);
  await say(st2, "what do you need from me");
  const m2 = stub(long, long);
  const r2 = await say(st2, "draft 1", { model: m2.model });
  eq(r2!.status, "draft_too_long");
  assert(/I couldn't write 1 inside the form's limit \(it was \d+ words and the limit is 60\), and I don't cut answers off mid-sentence/.test(r2!.reply), r2!.reply);
  assert(!r2!.reply.includes("books controllers"), "no part of a long draft is shown");

  const st3 = fakeStore([RAMP()]);
  await say(st3, "what do you need from me");
  const m3 = stub({ text: "At Brightline Health I was the senior accountant who", stop: "max_tokens" }, CLEAN);
  eq((await say(st3, "draft 1", { model: m3.model }))!.status, "drafted");
  assert(/stopped in the middle of a sentence/.test(m3.calls[1].messages[0].content));
  eq((await st3.shown("u"))!.drafts!.b.text, CLEAN);
});

Deno.test("WO-030/5 the model only through the gateway: a failure says it couldn't draft right now, leaves the question open, never throws", async () => {
  const store = fakeStore([SPONS(), RAMP()]);
  await say(store, "what do you need from me");
  // One question per message (review of #360): "skip" moves past the sponsorship question to the essay, now question 1.
  await say(store, "skip");
  const m = stub(new Error("OpenAI 503"));
  const r = await say(store, "draft 1", { model: m.model });
  eq(r!.status, "draft_model");
  assert(/^I couldn't draft 1 right now, so nothing changed and 1 is still open\./.test(r!.reply), r!.reply);
  eq(store.answers, []);
  eq(await store.countOpen("u"), 2);
  // The real gateway with no key (none here): not configured, before any network; the turn still answers.
  const noKey = modelConfig({ get: (k: string) => ({ CAREER_MODEL: "gpt-5-mini" } as Record<string, string>)[k] });
  eq(noKey.provider, "openai", "OpenAI only; never Anthropic by accident");
  const r2 = await say(store, "draft 1", { model: (p: any) => callModel({ ...noKey, model: "gpt-5-mini" }, p) });
  eq(r2!.status, "draft_model");
  // The question is still answered the usual way afterwards.
  const r3 = await say(store, "Ramp's tools are what I wished I had as a controller");
  eq(r3!.status, "answered_next", "saved, and the skipped sponsorship question is asked next");
  eq(store.answers, [["b", "Ramp's tools are what I wished I had as a controller"]]);
});

Deno.test("WO-030/6 ask once's guarantees hold for drafts: the thread's last word, a day, the numbers shown, and saved only on 'use N'", async () => {
  const store = fakeStore([SPONS(), RAMP()]);
  await say(store, "what do you need from me");
  // One question per message (review of #360): "skip" moves past the sponsorship question to the essay, now question 1.
  const shown = await say(store, "skip");
  assert(shown!.reply.includes(`For a written answer, say "draft 1" and I'll draft it from your confirmed facts for you to check first.`), shown!.reply);
  const m = stub(CLEAN);
  store.setIntent("career_brain");
  eq(await say(store, "draft 1", { model: m.model }), null, "not the last word: not a draft command");
  store.setIntent(QUESTIONS_INTENT);
  eq(await say(store, "draft 1", { model: m.model, thread: "other" }), null, "another thread's questions");
  eq((await say(store, "draft 7", { model: m.model }))!.reply, `I asked one question, so there's no 7. Say "draft 1".`);
  const notEssay = fakeStore([SPONS()]);
  await say(notEssay, "what do you need from me");
  eq((await say(notEssay, "draft 1", { model: m.model }))!.status, "draft_not_essay", "only a written answer is drafted");
  eq((await say(store, "use 1", { model: m.model }))!.status, "draft_none", "no draft yet: nothing to use");
  eq(m.calls.length, 0);
  const r = await say(store, "draft 1", { model: m.model });
  eq(r!.status, "drafted");
  assert(r!.reply.startsWith("Draft for 1, written only from your confirmed facts (F-001, F-002, F-003, F-004). Ramp's form doesn't say whether AI help is allowed, so this is a draft for you to edit, not a finished answer. Nothing is saved yet."), r!.reply);
  assert(r!.reply.endsWith(`Reply "use 1" to save it as your answer, "redo 1" for another version, or "1" and your own words.`), r!.reply);
  eq(store.answers, [], "shown, never saved on its own");
  eq(await store.countOpen("u"), 2);
  // The draft survives between turns on the account, beside the question shown.
  eq(Object.keys((await store.shown("u"))!.drafts!), ["b"]);
  // Redo: another version, the earlier one given to the model to differ from.
  const m2 = stub("I want to work at Ramp because I want to build finance software used by controllers. At Brightline Health I closed the monthly books in 5 days instead of 9.");
  eq((await say(store, "redo 1", { model: m2.model }))!.status, "drafted");
  assert(m2.calls[0].messages[0].content.includes(`Write a different version from this earlier one:\n${CLEAN}`));
  const second = (await store.shown("u"))!.drafts!.b.text;
  // A day later nothing is used.
  eq((await say(store, "use 1", { now: T + 25 * 3600000 }))!.status, "expired");
  eq(store.answers, []);
  // "use 1" saves exactly the draft shown, through store.answer (back in time: the draft is the thread's last word again).
  store.setIntent(QUESTIONS_INTENT);
  const u = await say(store, "use 1");
  eq(u!.status, "answered_next", "saved; the sponsorship question is asked next, so the questions stay the last word");
  eq(store.answers, [["b", second]]);
  assert(u!.reply.startsWith("Saved, as drafted. I won't ask this again:\nWhy do you want to work at Ramp?: \""), u!.reply);
  assert(u!.reply.includes("Will you"), `the next question: ${u!.reply}`);
  eq((await store.shown("u"))!.drafts ?? {}, {}, "a used draft is gone");
  eq((await say(store, "no"))!.status, "answered", "the other question is answered as it is asked");

  // Their own words instead of a draft: saved as typed, and the draft can no longer be used.
  const st2 = fakeStore([SPONS(), RAMP()]);
  await say(st2, "what do you need from me");
  await say(st2, "skip");
  await say(st2, "draft 1", { model: stub(CLEAN).model });
  await say(st2, "I want to build what I wished I had");
  eq(st2.answers, [["b", "I want to build what I wished I had"]]);
  st2.setIntent(QUESTIONS_INTENT);
  eq((await say(st2, "use 1"))!.status, "draft_none");
  eq(st2.answers.length, 1);
  // One question shown: "use it" is a command, never saved as the answer "use it".
  const one = fakeStore([RAMP()]);
  await say(one, "what do you need from me");
  eq((await say(one, "use it"))!.status, "draft_none");
  eq(one.answers, []);
  for (const t of ["draft 2", "write 2 for me", "can you draft it", "please write me a draft for 2"]) eq(parseDraftCommand(t)?.act, "draft", t);
  for (const t of ["redo 2", "draft 2 again", "try 2 again"]) eq(parseDraftCommand(t)?.act, "redo", t);
  for (const t of ["use 2", "use draft 2", "save the draft for 2"]) eq(parseDraftCommand(t)?.act, "use", t);
  for (const t of ["2 use my experience", "write code all day and love it", "I used Python"]) eq(parseDraftCommand(t), null, t);
});

const field = (label: string, type = "input_text", options: string[] = []) => ({
  name: label.toLowerCase().replace(/\W+/g, "_"), label, required: true, type, options: options.map((l) => ({ label: l, value: l })),
});

Deno.test("WO-030/7 the loop: stored with the form's AI words, shown, drafted, used, read back as a confirmed answer, filled for that posting only", async () => {
  const facts = { user_id: "TEST", answers: { first_name: { value: "Test", factId: "f1", confirmed: true } }, saved: {} };
  const form = [field("First name"), field("Will you now or in the future require sponsorship?", "multi_value_single_select", ["Yes", "No"]), field("Why do you want to work at Ramp?", "textarea")];
  const result = {
    state: "not_submitted", reason: "needs_answers", posting: "ashby:ramp:1", company: "Ramp",
    questions: form.slice(1).map((f) => ({ label: f.label, type: f.type, options: f.options.map((o) => o.label) })),
    ai_policy: [airwallexAllow],
  };
  const stored = questionsToStore(result, { facts: facts.answers, answered: new Set() });
  eq(stored.questions.map((x) => x.ai_policy ?? null), [null, airwallexAllow], "the form's AI words go with the written question only");
  eq(questionsToStore({ ...result, ai_policy: [canonicalBan, "First name"] }, { facts: facts.answers, answered: new Set() }).questions[1].ai_policy, canonicalBan, "only statements, never other labels");
  const rows = stored.questions.map((x, i) =>
    q({ id: `r${i}`, key: x.key as string, kind: x.kind as string, label: x.label as string, type: x.type as string, options: x.options as string[], company: "Ramp", job_ids: ["ashby:ramp:1"], ai_policy: (x.ai_policy as string) ?? null })
  );
  const store = fakeStore(rows);
  await say(store, "what do you need from me");
  // One question per message (review of #360): "skip" moves past the sponsorship question to the essay, now question 1.
  await say(store, "skip");
  const m = stub(CLEAN);
  const d = await say(store, "draft 1", { model: m.model });
  eq(d!.status, "drafted");
  assert(d!.reply.includes(`Ramp's form allows AI help ("We encourage you to use AI tools to help research, prepare, or refine your application`), d!.reply);
  eq(m.calls[0].messages[0].content.split("\n").filter((l: string) => l.startsWith("- [")).length, 4, "the four confirmed facts that fit, nothing else");
  await say(store, "use 1");
  await say(store, "no");
  eq(store.answers, [["r1", CLEAN], ["r0", "No"]]);
  const merged = factsWithTextAnswers(facts, rows.map((r) => ({ id: r.id, key: r.key, kind: r.kind, answer: r.answer! })));
  const plan = (job: string, fields: any[]) =>
    planBatch({ userId: "TEST", postings: [{ job_id: job, company: "Ramp", title: "", fields }], answers: merged.answers as any, saved: merged.saved as any, log: [], now: T });
  const p = plan("ashby:ramp:1", form);
  eq(p.needs, [], "nothing left to ask");
  const filled = Object.fromEntries(p.ready[0].fields.map((f) => [f.label, [f.value, f.factId]]));
  eq(filled["Why do you want to work at Ramp?"], [CLEAN, "text-answer:r1"], "the used draft fills the essay as the person's confirmed answer");
  const other = plan("ashby:brex:9", [field("Why do you want to work at Ramp?", "textarea")]);
  eq(other.needs.map((n) => n.label), ["Why do you want to work at Ramp?"], "never for another posting");
});

Deno.test("WO-030/8 wired: drafts persist on the account, the handler passes the gateway model, the computer carries the form's AI words, plain ES modules", async () => {
  // The service store keeps drafts beside the questions shown and reads back only well-formed ones.
  const writes: any[] = [];
  let value: any = { thread: "t", ids: ["a", "b"], at: new Date(T).toISOString(), drafts: { b: { text: CLEAN, at: new Date(T).toISOString(), n: 2 }, x: { text: 5 } } };
  const admin = {
    from: (_t: string) => {
      const qy: any = { select: () => qy, eq: () => qy, maybeSingle: async () => ({ data: { value }, error: null }),
        upsert: async (row: any) => { writes.push(row); value = row.value; return { error: null }; } };
      return qy;
    },
  };
  const s = supabaseQuestionStore(admin);
  eq((await s.shown("u"))!.drafts, { b: { text: CLEAN, at: new Date(T).toISOString(), n: 2 } }, "a malformed draft is dropped");
  await s.setShown("u", { thread: "t", ids: ["a"], at: new Date(T).toISOString() });
  eq([writes[0].key, writes[0].value.drafts], ["career:questions-shown", undefined], "a new showing starts with no drafts");
  assert(typeof s.onPostings === "function", "the service store reads a posting's questions");
  // The handler: the brain's gateway and model, drafts keep the questions as the last word.
  assert(/draft: \{ model: \(payload\) => callModel\(draftCfg, payload, \{ meter: draftMeter, role: "chat" \}\), facts: \(\) => \(\(ctx as any\)\.profile\?\.facts \?\? \[\]\) \}/.test(HANDLER));
  assert(HANDLER.includes(`const draftCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };`));
  assert(HANDLER.includes(`asked.status.startsWith("draft")`));
  assert(/await ledger\.record\(draftMeter\)/.test(HANDLER), "a draft's cost is recorded like the brain's");
  assert(APPLY.includes("aiPolicyStatements(current.schema.map((f: any) => f.label))"), "the engine carries the whole form's AI words");
  for (const src of [ESSAY_SRC, POLICY_SRC]) assert(!/with \{ type:|assert \{ type:/.test(src), "no JSON import attributes in anything the handler imports");
  assert(!/anthropic/i.test(ESSAY_SRC.replace(/\/\/.*$/gm, "")), "no provider is named in the drafting code; the gateway decides");
  // The model is offered only confirmed facts that fit, and is told the employer's question and company.
  const m = stub(CLEAN);
  const out = await draftEssay({ q: RAMP(), siblingLabels: [], deps: { model: m.model, facts: () => FACTS } });
  eq(out.ok, true);
  const msg = m.calls[0].messages[0].content as string;
  assert(msg.startsWith("Company: Ramp\nQuestion: Why do you want to work at Ramp?\nLength: at most 250 words, at most 2000 characters."), msg);
  assert(/Use ONLY the facts listed/.test(m.calls[0].system));
});
