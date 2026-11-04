// WO-025 (architect): the text mock interview and the pre-interview brief. A mock starts with one text, scores every
// answer with 127's rubric, nudges in one line and ends in a debrief that quotes only the person's words. Company
// questions and company facts come only from a record on file, quoted with their source label; with no record nothing
// is said about the company. "stop" alone is the carrier's word and never a mock command or answer.
// Run: deno test -A --no-check tests/architect/wo-025-mock.test.ts
import {
  brief,
  BRIEF_LIMIT,
  companyRecords,
  end,
  findRecord,
  IDLE_MS,
  MOCK_DONE_INTENT,
  MOCK_INTENT,
  MOCK_PAUSED_INTENT,
  mockKey,
  type MockState,
  type MockStore,
  mockTurn,
  next,
  parseMockCommand,
  recordName,
  start,
  supabaseMockStore,
} from "../../supabase/functions/_shared/career_mock.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { HYGIENE } from "../../evals/career/compare.ts";
import HANDLER from "../../supabase/functions/agent-chat/handler-career.ts" with { type: "text" };
import ERASE from "../../supabase/migrations/20261016120000_career_account_stated_facts.sql" with { type: "text" };

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const T = Date.parse("2026-10-20T15:00:00Z");
const MIN = 60_000;
const clean = (x: string) => x.replace(/\s+/g, " ").trim();

// A record shaped like the ones on file, for a company that does not exist anywhere else.
const FIXTURE = {
  company_id: "fixture-robotics",
  company_name: "Fixture Robotics, Inc.",
  as_of: "2026-10-01",
  data_sources: [{ label: "Fixture careers page", url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01", source_type: "official" }],
  screening_signals: {
    stated: [
      { statement: "Applications are reviewed on a rolling basis, so apply early.", source_url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01" },
      { statement: "Interviewers look for clear written communication about tradeoffs in your own projects.", source_url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01" },
    ],
  },
  interview_styles: [{ statement: "A practical coding exercise in a small repository, followed by a conversation about the choices you made.", source_url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01" }],
  process_stages: [
    { stage: "Recruiter call", source_url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01" },
    { stage: "Practical coding exercise", source_url: "https://careers.fixture-robotics.test/jobs", as_of: "2026-10-01" },
  ],
};

const ANSWERS = [
  "I'm a data analyst with 3 years at a payments startup. I built the weekly revenue dashboard in SQL and Python. It cut reporting time from 6 hours to 1 for 40 people.",
  "We had a board deck due Friday. First I split the work with two teammates. Then I wrote the queries and checked every number. In the end we shipped two days early.",
  "I would randomize by user, pick one primary metric and a guardrail, and size the test for the smallest lift we care about.",
  "On my last team I wrote the design doc for our data pipeline and explained the tradeoffs to 12 engineers. They adopted it in a month.",
  "Stuff happened and I fixed various things.",
  "Because I use the product every day and I want to work on the data behind it.",
];

// The thread around the mock: whatever the mock says is the last word; any text it passes on is answered by the brain.
function thread() {
  const kv = new Map<string, MockState>();
  let last: string | null = null;
  const replies: string[] = [];
  const store: MockStore = {
    get: async (u, t) => (kv.has(`${u}:${t}`) ? structuredClone(kv.get(`${u}:${t}`)!) : null),
    save: async (u, t, s) => void kv.set(`${u}:${t}`, structuredClone(s)),
    clear: async (u, t) => void kv.delete(`${u}:${t}`),
    lastAssistantIntent: async () => last,
  };
  const say = async (message: string, now: number) => {
    const r = await mockTurn({ message, userId: "u1", threadId: "t1", now, store });
    if (r) replies.push(r.reply);
    last = r ? r.intent : "agent";
    return r;
  };
  return { kv, store, say, replies, state: () => kv.get("u1:t1") ?? null, brainSpeaks: () => void (last = "agent") };
}
const quotes = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/\.\.\.$/, ""));
function hygieneOk(r: string, where: string) {
  for (const h of HYGIENE) assert(!h.test(r), `${where}: ${h.what}\n${r}`);
}

Deno.test("WO-025/1 the texts that drive a mock; 'stop' and the other carrier words alone are never one", () => {
  eq(parseMockCommand("mock me for data analyst at Stripe"), { kind: "start", role: "data analyst", company: "Stripe", minutes: 20 });
  eq(parseMockCommand("Start a mock interview."), { kind: "start", role: "", company: null, minutes: 20 });
  eq(parseMockCommand("start a 10 minute mock interview for a software engineer role at Google"), { kind: "start", role: "software engineer", company: "Google", minutes: 10 });
  eq(parseMockCommand("let's do a mock interview for product manager at Notion"), { kind: "start", role: "product manager", company: "Notion", minutes: 20 });
  eq(parseMockCommand("mock me for stripe"), { kind: "start", role: "", company: "stripe", minutes: 20 }, "a company with a record named alone is the company");
  eq(parseMockCommand("end mock"), { kind: "end" });
  eq(parseMockCommand("Stop the mock"), { kind: "end" });
  eq(parseMockCommand("end the interview"), { kind: "end" });
  eq(parseMockCommand("done"), { kind: "done" });
  eq(parseMockCommand("skip"), { kind: "skip" });
  eq(parseMockCommand("resume mock"), { kind: "resume" });
  for (const t of ["stop", "STOP", "Stop.", "end", "cancel", "quit", "unsubscribe", "stopall", "start", "help"]) eq(parseMockCommand(t), null, t);
  for (const t of ["mock interview tips", "what is a mock interview?", "stop sending me jobs", "I'm done with Stripe"]) eq(parseMockCommand(t), null, t);
});

Deno.test("WO-025/2 a full session: start, six answers, a nudge after each, then the debrief", async () => {
  const th = thread();
  const s = await th.say("mock me for data analyst at Stripe", T);
  assert(s && s.status === "started" && s.intent === MOCK_INTENT, "the mock starts");
  assert(/About 20 minutes, 6 questions, by text \(voice comes later\)/.test(s.reply), s.reply);
  assert(/Q1 of 6: Tell me about yourself/.test(s.reply), s.reply);
  const st = th.state()!;
  eq(st.questions.length, 6, "20 minutes is 6 questions");
  eq(st.questions.map((q) => q.kind), ["opener", "behavioral", "technical", "company", "technical", "closer"]);
  for (const q of st.questions.filter((q) => q.kind === "technical")) assert(/question bank|set$/.test(q.from), `technical from a bank: ${q.from}`);
  let r = s;
  for (let i = 0; i < ANSWERS.length; i++) {
    r = (await th.say(ANSWERS[i], T + (i + 1) * 2 * MIN))!;
    assert(r, `answer ${i + 1} is the mock's`);
    assert(/^\d+ of 15\. /.test(r.reply), `a score and a nudge first: ${r.reply}`);
    if (i < ANSWERS.length - 1) {
      eq(r.intent, MOCK_INTENT);
      assert(r.reply.includes(`Q${i + 2} of 6: `), r.reply);
    }
  }
  eq([r.status, r.intent], ["ended", MOCK_DONE_INTENT]);
  assert(/Debrief, data analyst mock for Stripe: 6 of 6 answered\. Average [\d.]+ of 15 \(a practice score, not a hiring prediction\)\./.test(r.reply), r.reply);
  assert(/Scores out of 15: Q1 \d+, Q2 \d+, Q3 \d+, Q4 \d+, Q5 \d+, Q6 \d+\./.test(r.reply), r.reply);
  assert(/\nStrongest: Q\d "[^"]+" Q\d "[^"]+"\nWeakest: Q\d "[^"]+" Q\d "[^"]+"\n/.test(r.reply), "2 strongest and 2 weakest moments");
  assert(/Practice next:\n1\. .+\n2\. .+\n3\. .+$/.test(r.reply), "3 practice items");
  assert(r.reply.includes("Q5 \"Stuff happened and I fixed various things"), "the vague answer is named as a weak moment, in its own words");
  eq(th.state(), null, "a finished mock leaves nothing stored");
  for (const x of th.replies) hygieneOk(x, "session reply");
});

Deno.test("WO-025/3 the debrief quotes only the person's words and states no number the rubric did not give", () => {
  let st = start({ role: "data analyst", company: "Stripe", now: T }).state;
  let last = "";
  for (let i = 0; i < ANSWERS.length; i++) {
    const r = next(st, ANSWERS[i], T + (i + 1) * MIN);
    st = r.state;
    last = r.reply;
  }
  const debrief = last.slice(last.indexOf("Debrief"));
  const moments = debrief.split("\n").filter((l) => /^(Strongest|Weakest):/.test(l)).join(" ");
  const q = quotes(moments);
  eq(q.length, 4);
  for (const x of q) assert(ANSWERS.some((a) => a.includes(x)), `quoted words are the person's own: "${x}"`);
  // Every number in the debrief is a score, a count, a question number or the 15-point scale; none is a made-up stat.
  const nums = (debrief.replace(/"[^"]*"/g, "").match(/\d+(?:\.\d+)?%?/g) || []);
  assert(!nums.some((n) => n.endsWith("%")), "no percent anywhere");
  assert(!/percentile|better than|top \d|hire(?:d)? rate|chance/i.test(debrief), "no fabricated stat");
  const d = end(st, T + 20 * MIN, "asked").debrief;
  eq(d.practice.length, 3);
  for (const m of [...d.strongest, ...d.weakest]) assert(ANSWERS.some((a) => a.includes(m.quote.replace(/\.\.\.$/, ""))), m.quote);
});

Deno.test("WO-025/4 'stop' alone neither starts, ends nor answers a mock, even while its question waits", async () => {
  const th = thread();
  for (const t of ["stop", "STOP"]) eq(await th.say(t, T), null, "nothing starts");
  await th.say("start a mock interview", T);
  const before = JSON.stringify(th.state());
  for (const t of ["stop", "Stop", "end", "cancel", "quit"]) {
    eq(await th.say(t, T + MIN), null, `${t} passes to the channel and the brain`);
    eq(JSON.stringify(th.state()), before, `${t} is not scored and ends nothing`);
  }
  // Even right after the mock's question (its last word), "stop" is still not an answer.
  await th.say("resume mock", T + MIN);
  eq(await th.say("stop", T + MIN), null);
  eq([th.state()!.status, th.state()!.answers.length], ["running", 0]);
  eq(th.state()!.answers.length, 0);
  const r = await th.say("stop the mock", T + 2 * MIN);
  eq([r?.status, r?.intent], ["ended", MOCK_DONE_INTENT], "'stop the mock' ends it");
  eq(th.state(), null);
});

Deno.test("WO-025/5 an answer counts only while the mock's question is the thread's last word", async () => {
  const th = thread();
  await th.say("mock me for software engineer at Google", T);
  th.brainSpeaks(); // the person asked something else and the brain answered it
  eq(await th.say("I built a scheduler in Go that cut job latency by 40%.", T + MIN), null, "not a mock answer after the brain spoke");
  eq(th.state()!.answers.length, 0);
  const back = await th.say("resume mock", T + 2 * MIN);
  assert(back && back.intent === MOCK_INTENT && /^Back to the mock\.\n\nQ1 of 6: /.test(back.reply), back?.reply);
  const a = await th.say("I built a scheduler in Go that cut job latency by 40%.", T + 3 * MIN);
  assert(a && a.status === "answered", "after resume, the answer is the mock's");
  eq(th.state()!.answers.length, 1);
  // "done" ends the mock only while its question is the last word.
  th.brainSpeaks();
  eq(await th.say("done", T + 4 * MIN), null);
  await th.say("resume mock", T + 4 * MIN);
  const d = await th.say("done", T + 5 * MIN);
  eq(d?.status, "ended");
});

Deno.test("WO-025/6 30 minutes idle: the next text is not an answer; 'end mock' still gives the debrief", async () => {
  const th = thread();
  await th.say("mock me for data analyst", T);
  await th.say(ANSWERS[0], T + MIN);
  eq(await th.say(ANSWERS[1], T + MIN + IDLE_MS + 1), null, "an idle mock takes no answer");
  eq(th.state()!.answers.length, 1);
  const resumed = await th.say("resume mock", T + MIN + IDLE_MS + 2);
  assert(resumed && /stopped after 30 minutes/.test(resumed.reply), resumed?.reply);
  const e = await th.say("end mock", T + MIN + IDLE_MS + 3);
  assert(e && /^The mock stopped after 30 minutes with no reply\. Debrief, data analyst mock: 1 of 6 answered\./.test(e.reply), e?.reply);
  eq(th.state(), null);
  const none = await th.say("end mock", T + MIN + IDLE_MS + 4);
  assert(none && /No mock is running/.test(none.reply));
});

Deno.test("WO-025/7 the 20 minutes run out: the answer is scored and the debrief follows", async () => {
  const th = thread();
  await th.say("mock me for data analyst", T);
  await th.say(ANSWERS[0], T + 5 * MIN);
  const r = await th.say(ANSWERS[1], T + 21 * MIN);
  assert(r && r.status === "ended" && /Time is up \(20 minutes\)\. Debrief, data analyst mock: 2 of 6 answered\./.test(r.reply), r?.reply);
});

Deno.test("WO-025/8 a company with no record never gets invented questions; a near name is not a record", async () => {
  for (const name of ["Bain Capital", "Citadel", "Rampart", "Acme Widgets", "fintech", "dev-tools startup", "a", ""]) eq(findRecord(name), null, name);
  for (const [name, id] of [["Bain", "bain"], ["goldman", "goldman-sachs-ibd"], ["JP Morgan", "jpmorgan-ibd"], ["McKinsey & Company", "mckinsey"], ["D. E. Shaw", "de-shaw"], ["Stripe", "stripe"]]) {
    eq(findRecord(name)?.company_id, id, name);
  }
  const th = thread();
  const r = await th.say("mock me for data analyst at Acme Widgets", T);
  assert(r && /No record for Acme Widgets on file, so nothing here is about how they interview\./.test(r.reply), r?.reply);
  const qs = th.state()!.questions;
  assert(!qs.some((q) => q.kind === "company"), "no company question without a record");
  for (const q of qs) {
    assert(!/record|they (?:screen|look|ask)|acme widgets'?s? (?:interview|process)/i.test(q.q) || q.kind === "closer", `no company claim: ${q.q}`);
    if (q.q.includes("Acme")) eq(q.q, "Why Acme Widgets, specifically?", "the company's name appears only in the why-them question");
  }
  // A record's question quotes the record, with its source label, and nothing else about the company.
  const f = start({ role: "software engineer", company: "Fixture Robotics", now: T, lib: [FIXTURE] }).state;
  const cq = f.questions.find((q) => q.kind === "company")!;
  assert(cq, "a record gives one company question");
  eq(cq.q, `Fixture Robotics' record says (official, careers.fixture-robotics.test, 2026-10-01): "Interviewers look for clear written communication about tradeoffs in your own projects". Tell me about a time you showed that.`);
  // Bank items that name a company are left out of every role's technical questions.
  for (const role of ["software engineer", "data analyst", "consultant", "investment banking analyst", "product manager", "quant trader"]) {
    for (let k = 0; k < 6; k++) {
      const p = start({ role, company: null, now: T + k * MIN }).state.questions;
      for (const q of p.filter((x) => x.kind === "technical")) assert(!/\b(?:meta|facebook|twitter|uber|amazon|google|mckinsey|faang)\b/i.test(q.q), `${role}: ${q.q}`);
    }
  }
});

Deno.test("WO-025/9 the brief: what the record says with its labels, the role's question types, exactly 10 points", () => {
  const b = brief({ company: "Stripe", role: "data analyst", postings: [{ title: "Data Analyst", company: "Stripe", description: "SQL, Python and experimentation on payments data.", url: "https://example.test/1" }] });
  eq(b.has_record, true);
  eq(b.plan.length, 10);
  for (let i = 1; i <= 10; i++) assert(b.text.includes(`\n${i}. `), `point ${i}`);
  assert(/What Stripe's record says \(as of 2026-10-12\): Steps: .+ \(public page, stripe\.com, 2026-10-12\)\./.test(b.text), b.text);
  assert(/Questions they asked: the record has no list of Stripe's questions/.test(b.text), "says plainly the record holds no question list");
  assert(/From the posting \(Data Analyst\): it names .*sql/.test(b.text), b.text);
  assert(/Top question types for data analyst: /.test(b.text));
  const raw = clean(JSON.stringify(findRecord("Stripe")));
  for (const q of quotes(b.text.split("10-point plan:")[0])) assert(raw.includes(q), `quoted from the record: "${q}"`);

  const none = brief({ company: "Acme Widgets", role: "nurse" });
  eq([none.has_record, none.plan.length], [false, 10]);
  assert(/No record for Acme Widgets on file, so nothing here is about how they interview\. Role-only plan below\./.test(none.text), none.text);
  assert(/no question bank for nurse yet/.test(none.text));
  assert(!/record says|They look for|Steps:/.test(none.text), "nothing about the company");

  // Every company on file, two roles: one text message each, no markdown, every quote from that record.
  const recs = companyRecords();
  eq(recs.length, 33, "33 companies have records today (archetypes are not companies)");
  for (const c of recs) {
    for (const role of ["software engineer", "investment banking analyst"]) {
      const x = brief({ company: recordName(c), role });
      assert(x.text.length <= BRIEF_LIMIT, `${c.company_id}: ${x.text.length} chars`);
      eq(x.plan.length, 10);
      hygieneOk(x.text, `brief ${c.company_id}`);
      const rec = clean(JSON.stringify(c));
      for (const q of quotes(x.text.split("10-point plan:")[0])) assert(rec.includes(q), `${c.company_id}: "${q}" is in the record`);
    }
  }
});

Deno.test("WO-025/10 hygiene: no markdown, no AI talk, no question pile-up, one text each, over every record and role", () => {
  const roles = ["software engineer", "data analyst", "consultant", "investment banking analyst", "product manager", "quant trader", "law associate", "medical resident", "real estate analyst", "nurse", ""];
  let replies = 0;
  for (const c of [...companyRecords().map(recordName), "Acme Widgets", null]) {
    for (const role of roles) {
      let st = start({ role, company: c, now: T }).state;
      const s = start({ role, company: c, now: T });
      hygieneOk(s.reply, `start ${role} at ${c}`);
      for (const q of st.questions.filter((q) => q.kind === "company")) assert(quotes(q.q).every((x) => clean(JSON.stringify(findRecord(c))).includes(x)), q.q);
      for (let i = 0; i < st.questions.length; i++) {
        const r = next(st, ANSWERS[i % ANSWERS.length], T + (i + 1) * MIN);
        hygieneOk(r.reply, `answer ${i + 1}, ${role} at ${c}`);
        st = r.state;
        replies++;
      }
    }
  }
  assert(replies > 1500, `${replies} replies checked`);
});

Deno.test("WO-025/11 a real interview is never helped and never scored as practice", async () => {
  const th = thread();
  await th.say("mock me for data analyst at Stripe", T);
  const r = await th.say("I'm in my real interview right now, the interviewer just asked about SQL, what do I say", T + MIN);
  eq([r?.status, r?.intent], ["live_refused", MOCK_PAUSED_INTENT]);
  assert(r && /can't help during a real interview/.test(r.reply));
  eq(th.state()!.answers.length, 0, "not scored");
  // A practice answer that mentions an interview in the past is still an answer.
  await th.say("resume mock", T + 2 * MIN);
  const a = await th.say("During my internship interview prep I helped 3 classmates, and we all got offers.", T + 3 * MIN);
  eq(a?.status, "answered");
});

Deno.test("WO-025/12 the session lives in career_watch_kv under career:mock:<thread>, which an account erase deletes", async () => {
  eq(mockKey("t-123"), "career:mock:t-123");
  assert(!mockKey("t-123").startsWith("career:turn:"), "not a request receipt, the one kind of row an erase keeps");
  assert(ERASE.includes("delete from career_watch_kv where user_id=p_user and key not like 'career:turn:%';"), "erase deletes every other row");
  const calls: string[] = [];
  const q = (op: string) => {
    const chain: any = {
      select: (c: string) => (calls.push(`${op}.select(${c})`), chain),
      eq: (k: string, v: string) => (calls.push(`${op}.eq(${k},${v})`), chain),
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async (row: any, o: any) => (calls.push(`${op}.upsert(${row.key},${o.onConflict})`), { error: null }),
      delete: () => (calls.push(`${op}.delete`), chain),
      then: (res: any) => res({ error: null }),
    };
    return chain;
  };
  const admin = { from: (t: string) => q(t) };
  const store = supabaseMockStore(admin);
  eq(await store.get("u1", "t1"), null);
  await store.save("u1", "t1", start({ role: "", now: T }).state);
  await store.clear("u1", "t1");
  eq(calls, [
    "career_watch_kv.select(value)", "career_watch_kv.eq(user_id,u1)", "career_watch_kv.eq(key,career:mock:t1)",
    "career_watch_kv.upsert(career:mock:t1,user_id,key)",
    "career_watch_kv.delete", "career_watch_kv.eq(user_id,u1)", "career_watch_kv.eq(key,career:mock:t1)",
  ]);
});

Deno.test("WO-025/13 the brain's tools: interview_brief, and interview questions that find the company's record", async () => {
  const tools = Object.fromEntries(careerTools({ postings: async () => [] }).map((t) => [t.name, t]));
  const ctx = { userId: "u1", threadId: "t1", now: T, state: {} as Record<string, any> };
  const b = await tools.interview_brief.run({ company: "McKinsey", role: "consultant" }, ctx) as any;
  eq([b.has_record, b.company, b.plan.length], [true, "McKinsey & Company", 10]);
  const n = await tools.interview_brief.run({ company: "Acme Widgets", role: "nurse" }, ctx) as any;
  eq([n.has_record, n.plan.length], [false, 10]);
  const q = await tools.get_interview_questions.run({ role: "software engineer", company: "Stripe" }, ctx) as any;
  eq(q.company_record, true, "the record is found by the company's name");
  const z = await tools.get_interview_questions.run({ role: "software engineer", company: "Bain Capital" }, ctx) as any;
  eq(z.company_record, false);
});

Deno.test("WO-025/14 the handler runs the mock right after the card, behind the same guards, before any brain", () => {
  const card = HANDLER.indexOf("await cardTurn(");
  const mock = HANDLER.indexOf("await mockTurn(");
  const brain = HANDLER.indexOf('chooseBrain(Deno.env) === "agent"');
  assert(card > 0 && mock > card && brain > mock, "card, then mock, then the brain");
  assert(/const mock = !crisisText && !card && !careerTask && !careerBatch && !host\.isHostControlled\(message, ctx\)\s*\?\s*await mockTurn\(\{ message, userId: user\.id, threadId: tid, now: Date\.now\(\), store: supabaseMockStore\(admin\) \}\)\s*:\s*null;/.test(HANDLER), "same guards as the card");
  assert(/\} else if \(mock\) \{\s*\/\/[^\n]*\n\s*out = \{ reply: mock\.reply, intent: mock\.intent, resultStatus: mock\.status, contained: false, handler: "mock" \};/.test(HANDLER), "the mock's intent becomes the reply's, so the last-word rule can read it");
});

Deno.test("WO-025/15 the mock's read runs every turn: when it fails, an ordinary text goes on without the mock; a mock command still says so", async () => {
  const broken: MockStore = {
    get: () => Promise.reject(new Error("read failed")),
    save: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    lastAssistantIntent: () => Promise.resolve(null),
  };
  const ordinary = await mockTurn({ message: "find me analyst jobs in Denver", userId: "u", threadId: "t", now: 0, store: broken });
  if (ordinary !== null) throw new Error("an ordinary text must go on to the brain");
  let threw = false;
  try { await mockTurn({ message: "end mock", userId: "u", threadId: "t", now: 0, store: broken }); } catch { threw = true; }
  if (!threw) throw new Error("a mock command with an unreadable session must not pretend");
});
