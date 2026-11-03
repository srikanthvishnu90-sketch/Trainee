// SERIAL-1490 / SERIAL-1491 at the chat turn, in memory: a possible current-employer match asks once and queues nothing;
// the next "no" queues exactly that posting once; "yes" keeps it out; the same answer again is told it stands (nothing
// asked again, nothing queued twice); in a batch the question attaches to its posting and the rest queue.
import assertNode from "node:assert/strict";
import { applyTurn, EMPLOYER_ANSWER_INTENT, EMPLOYER_ASK_INTENT, employerAnswerAsk, employerAnswerTurn, memoryEmployerAskStore } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T16:00:00Z");
const posting = (id: string, company: string, title = "Data Analyst") => ({ job_id: `greenhouse:${id}:1`, company, title, url: `https://boards.greenhouse.io/${id}/jobs/1`, location: "Chicago, IL" });
const POSTINGS = [posting("acmerobotics", "Acme Robotics Inc"), posting("acmehealth", "Acme Health"), posting("contoso", "Contoso Analytics"), posting("fabrikam", "Fabrikam Data")];

// One thread: the handler writes each reply's intent and meta to agent_messages; here the same, in memory.
function thread(facts: any[]) {
  const wants = memoryWantStore(), messages: { role: string; thread_id: string; meta?: Record<string, any> | null }[] = [];
  const store = memoryEmployerAskStore(messages);
  const search = async (words: string[]) => POSTINGS.filter((p) => words.every((w) => `${p.company} ${p.title}`.toLowerCase().includes(w.toLowerCase())));
  const base = { userId: "u1", now: NOW, wants, apps: async () => [], facts, employerAnswers: () => store.answers("t1") };
  const say = async (message: string, shortlist: any[] | null = null) => {
    const a = await employerAnswerTurn({ ...base, message, threadId: "t1", store });
    if (a) {
      messages.push({ role: "assistant", thread_id: "t1", meta: { intent: a.intent, ...(a.answers?.length ? { employer_answers: a.answers } : {}), ...(a.pending?.length ? { employer_question: a.pending } : {}) } });
      return { kind: "answer" as const, ...a };
    }
    const q = await applyTurn({ ...base, message, postings: { search }, shortlist });
    if (!q) return null;
    const asking = !!q.ask?.length;
    messages.push({ role: "assistant", thread_id: "t1", meta: { intent: asking ? EMPLOYER_ASK_INTENT : q.intent, ...(asking ? { employer_question: q.ask } : {}) } });
    return { kind: "ask" as const, ...q, intent: asking ? EMPLOYER_ASK_INTENT : q.intent };
  };
  return { say, wants, messages };
}
const keys = async (w: ReturnType<typeof memoryWantStore>) => (await w.list("u1")).map((x) => x.posting_key).sort();

Deno.test("the answer grammar: yes and no, bare or with the company; anything else is not an answer", () => {
  eq(employerAnswerAsk("no"), { kind: "no", company: null });
  eq(employerAnswerAsk("No, I don't work there."), { kind: "no", company: null });
  eq(employerAnswerAsk("yes"), { kind: "yes", company: null });
  eq(employerAnswerAsk("yes, that's where I work"), { kind: "yes", company: null });
  eq(employerAnswerAsk("Acme Robotics Inc: no"), { kind: "no", company: "Acme Robotics Inc" });
  eq(employerAnswerAsk("Acme Health - yes"), { kind: "yes", company: "Acme Health" });
  for (const m of ["apply to Acme", "maybe", "what do you need from me", "no idea what you mean", "not sure"]) eq(employerAnswerAsk(m), null, m);
});

Deno.test("a possible match asks once and queues nothing; no queues it once; a second no stands; a later ask does not ask again", async () => {
  const t = thread([{ kind: "experience", text: "I work at Acme" }]);
  const ask = (await t.say("apply to the Data Analyst role at Acme Robotics Inc"))!;
  eq([ask.kind, ask.status, ask.intent], ["ask", "asking_employer", EMPLOYER_ASK_INTENT]);
  assert(/One question before I queue it/.test(ask.reply) && /is Acme Robotics Inc where you work now\?/.test(ask.reply) && /nothing is queued there until you do/.test(ask.reply), ask.reply);
  eq(await keys(t.wants), []);
  const no = (await t.say("no"))!;
  eq([no.kind, no.status, no.intent], ["answer", "queued", EMPLOYER_ANSWER_INTENT]);
  assert(/Noted, not your employer\. Queued: Data Analyst at Acme Robotics Inc/.test(no.reply) && /Nothing is sent and nothing is filled yet/.test(no.reply), no.reply);
  eq(await keys(t.wants), ["greenhouse:acmerobotics:1"]);
  const again = (await t.say("no"))!;
  eq([again.kind, again.status], ["answer", "stands"]);
  assert(/That stands: Acme Robotics Inc was queued once\. Nothing was asked again and nothing more was queued/.test(again.reply), again.reply);
  eq(await keys(t.wants), ["greenhouse:acmerobotics:1"], "not queued twice");
  const later = (await t.say("apply to the Data Analyst role at Acme Robotics Inc"))!;
  eq([later.kind, later.status], ["ask", "already"], `their earlier no is remembered on the thread: ${later.reply}`);
  eq(await keys(t.wants), ["greenhouse:acmerobotics:1"]);
});

Deno.test("yes keeps the posting out; a second yes stands; the next ask for it is a plain refusal in their own words, never a question again", async () => {
  const t = thread([{ kind: "experience", text: "I work at Acme" }]);
  const ask = (await t.say("apply to the Data Analyst role at Acme Health"))!;
  eq([ask.kind, ask.status], ["ask", "asking_employer"]);
  const yes = (await t.say("yes"))!;
  eq([yes.kind, yes.status, yes.intent], ["answer", "is_employer", EMPLOYER_ANSWER_INTENT]);
  assert(/Noted: Acme Health is where you work now/.test(yes.reply) && /nothing was queued/.test(yes.reply), yes.reply);
  eq(await keys(t.wants), []);
  const again = (await t.say("yes"))!;
  eq([again.kind, again.status], ["answer", "stands"]);
  assert(/Acme Health is where you work, so nothing was queued there/.test(again.reply), again.reply);
  const later = (await t.say("apply to the Data Analyst role at Acme Health"))!;
  eq([later.kind, later.status], ["ask", "refused"]);
  assert(/current employer \(you said so when I asked\)/.test(later.reply) && !/where you work now\?/.test(later.reply), later.reply);
  eq(await keys(t.wants), []);
});

Deno.test("an exact-name fact refuses outright; a distinct employer is not confused; a bare yes or no with no question open is nobody's", async () => {
  const t = thread([{ kind: "experience", text: "I work at Contoso Analytics" }]);
  const exact = (await t.say("apply to the Data Analyst role at Contoso Analytics"))!;
  eq([exact.kind, exact.status], ["ask", "refused"]);
  assert(/Contoso Analytics is your current employer/.test(exact.reply) && /apply anyway/.test(exact.reply) && !/\btheir\b|\bthey (?:said|set|did|work|named|already)\b|themselves|the person/i.test(exact.reply), `to the person, in the second person: ${exact.reply}`);
  const other = (await t.say("apply to the Data Analyst role at Fabrikam Data"))!;
  eq([other.kind, other.status], ["ask", "queued"]);
  eq(await keys(t.wants), ["greenhouse:fabrikam:1"]);
  eq(await t.say("no"), null, "no question is open: not this turn's");
  eq(await t.say("yes"), null);
});

Deno.test("a batch: the question attaches to the possible-match postings only, the rest queue; the answer names the company when two are open", async () => {
  const t = thread([{ kind: "experience", text: "I work at Acme" }]);
  const list = POSTINGS.map((p) => ({ id: p.job_id, url: p.url, company: p.company, title: p.title, location: p.location }));
  const batch = (await t.say("apply to these", list))!;
  eq([batch.kind, batch.status, batch.intent], ["ask", "queued", EMPLOYER_ASK_INTENT], batch.reply);
  eq(await keys(t.wants), ["greenhouse:contoso:1", "greenhouse:fabrikam:1"], "the two distinct employers queue");
  assert(/Queued 2 of the 4/.test(batch.reply) && /2 questions before I queue these/.test(batch.reply) && /is Acme Robotics Inc where you work now\?/.test(batch.reply) && /is Acme Health where you work now\?/.test(batch.reply), batch.reply);
  eq(batch.ask?.map((q) => q.company), ["Acme Robotics Inc", "Acme Health"]);
  const which = (await t.say("no"))!;
  eq([which.kind, which.status], ["answer", "which"], "two open: a bare no says which");
  eq(await keys(t.wants), ["greenhouse:contoso:1", "greenhouse:fabrikam:1"]);
  const one = (await t.say("Acme Robotics Inc: no"))!;
  eq([one.kind, one.status, one.intent], ["answer", "queued", EMPLOYER_ASK_INTENT], "one still open, so the question stays the last word");
  assert(/Queued: Data Analyst at Acme Robotics Inc/.test(one.reply) && /Still open: Acme Health/.test(one.reply), one.reply);
  eq(await keys(t.wants), ["greenhouse:acmerobotics:1", "greenhouse:contoso:1", "greenhouse:fabrikam:1"]);
  const last = (await t.say("yes"))!;
  eq([last.kind, last.status, last.intent], ["answer", "is_employer", EMPLOYER_ANSWER_INTENT]);
  eq(await keys(t.wants), ["greenhouse:acmerobotics:1", "greenhouse:contoso:1", "greenhouse:fabrikam:1"]);
  const rerun = (await t.say("apply to these", list))!;
  eq(rerun.status, "already", `three already queued, Acme Health refused as theirs, nothing asked again: ${rerun.reply}`);
  assert(!/where you work now\?/.test(rerun.reply) && /you said so when I asked/.test(rerun.reply), rerun.reply);
  eq((await keys(t.wants)).length, 3);
});
