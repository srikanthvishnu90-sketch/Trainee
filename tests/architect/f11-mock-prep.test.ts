// FEATURE 11: the pieces of posting-bound mocks, unit by unit (career_mock_prep.ts), and mockTurn with an in-memory store:
// requirements only from the posting's words, the technical/behavioral mix by sector, answer keys from the bank, grading,
// the judge behind CAREER_MOCK_JUDGE (metered, held to the key, no invented facts), the weak-spot fold, the drill asks.
import assertNode from "node:assert/strict";
import {
  answerKeys, bankItems, checkVerdict, covers, debriefTail, fitOf, isDrillAsk, isWeakListAsk, matchPosting, type MockPrep, modelJudge,
  pastedJd, postingPlan, requirementsOf, supabaseMockPrep, technicalShare, weakSpots,
} from "../../supabase/functions/_shared/career_mock_prep.ts";
import { callModel } from "../../supabase/functions/_shared/model_gateway.ts";
import { fakeAnthropic } from "./helpers/fake_anthropic.ts";
import { MOCK_INTENT, mockTurn, type MockState, type MockStore, parseMockCommand } from "../../supabase/functions/_shared/career_mock.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const JD = "Data Analyst. You will write SQL, design A/B tests, use statistics, and build Tableau dashboards. Strong communication with stakeholders. Python a plus.";

Deno.test("F11/1 requirements come only from the posting's own words, whole words, in its order", () => {
  eq(requirementsOf(JD).map((r) => r.label), ["SQL", "A/B testing", "statistics", "Tableau", "dashboards", "communication", "working with stakeholders", "Python"]);
  eq(requirementsOf("We are a good team that goes far and values going the extra mile."), [], "127's substring 'go' never counts: 'good', 'goes'");
  eq(requirementsOf("Backend engineer: Go, Kubernetes and AWS."), [{ key: "go", label: "Go", kind: "technical" }, { key: "kubernetes", label: "Kubernetes", kind: "technical" }, { key: "aws", label: "AWS", kind: "technical" }]);
  eq(requirementsOf("Java and JavaScript").map((r) => r.key), ["java", "javascript"]);
  eq(requirementsOf(""), []);
});

Deno.test("F11/2 the plan: opener, the posting's technical requirements with bank questions first, then behavioral, then why the company", () => {
  const reqs = requirementsOf(JD);
  const qs = postingPlan({ role: "data analyst", company: "Acme", posting: { title: "Data Analyst", company: "Acme", job_id: "x", url: null, source: "application", requirements: reqs }, minutes: 20, seed: 7, sector: "data", questionCount: 6 });
  eq(qs.map((q) => q.kind), ["opener", "technical", "technical", "technical", "behavioral", "closer"]);
  eq(qs.slice(1, 5).map((q) => q.skill), ["SQL", "A/B testing", "statistics", "communication"]);
  for (const q of qs.slice(1, 4)) assert(/^The posting asks for [^.]+\. /.test(q.q) && (q.keys ?? []).length >= 1, JSON.stringify(q));
  eq(qs[5].q, "Why Acme, specifically?");
  assert(technicalShare("pm") < technicalShare("data") && technicalShare("swe") > technicalShare("finance"));
  const pm = postingPlan({ role: "product manager", company: null, posting: { title: "PM", company: "", job_id: null, url: null, source: "pasted", requirements: requirementsOf("Product sense, SQL, communication, stakeholders, leadership.") }, minutes: 20, seed: 1, sector: "pm", questionCount: 6 });
  eq(pm.filter((q) => q.kind === "technical").length, 2, "a PM mock leans behavioral");
  for (const q of [...qs, ...pm]) assert(!/\b(?:twitter|facebook|uber|meta)\b/i.test(q.q), `no bank item naming another company: ${q.q}`);
});

Deno.test("F11/3 answer keys are the bank item's own key points; coverage is by word stems", () => {
  eq(answerKeys("hypothesis, unit of randomisation, primary metric, guardrails, ramp plan."), ["hypothesis", "unit of randomisation", "primary metric", "guardrails", "ramp plan"]);
  eq(answerKeys("`DENSE_RANK()` partitioned by department."), ["dense rank", "partitioned by department"]);
  assert(covers("I'd randomise at the user unit", "unit of randomisation"));
  assert(!covers("I would look at numbers", "primary metric"));
  const items = bankItems("data analyst");
  assert(items.length >= 15 && items.every((it) => !/twitter|facebook|uber|snapchat|linkedin|intuit|faang/i.test(it.q)), "the data bank, without company-named items");
});

Deno.test("F11/4 grading: a technical answer that never touches the requirement or the key is weak; a full one is not", () => {
  const q = { n: 2, q: "The posting asks for SQL. Talk me through how you would do this: top three salaries per department.", kind: "technical" as const, from: "x", req: ["sql"], keys: ["dense rank", "partitioned by department"], skill: "SQL" };
  const weak = fitOf(q, { n: 2, text: "I would just look at the numbers.", skipped: false, scores: { structure: 1, evidence: 1, specificity: 1, total: 3 }, gaps: [], fix: "evidence", nudge: "" });
  assert(weak.weak && weak.named_req === false && weak.covered.length === 0, JSON.stringify(weak));
  const strong = fitOf(q, { n: 2, text: "A CTE with DENSE_RANK() partitioned by department, ordered by salary, then keep rank <= 3.", skipped: false, scores: { structure: 2, evidence: 2, specificity: 1, total: 5 }, gaps: [], fix: null, nudge: "" });
  assert(!strong.weak && strong.named_req === true && strong.covered.length === 2, JSON.stringify(strong));
  const story = fitOf({ ...q, kind: "behavioral", req: ["communication"], keys: [] }, { n: 2, text: "x", skipped: false, scores: { structure: 1, evidence: 1, specificity: 2, total: 4 }, gaps: [], fix: "structure", nudge: "" });
  assert(story.weak && /structure/.test(story.why));
});

Deno.test("F11/5 the judge: rubric-anchored prompt, Claude only, metered with one cost row, held to the key, never inventing facts", async () => {
  eq(checkVerdict({ covered: ["dense rank", "made up"], verdict: "ok", fix: "Explain the partition step." }, ["dense rank", "partitioned by department"], "q a"), { covered: ["dense rank"], verdict: "ok", fix: "Explain the partition step." });
  eq(checkVerdict({ covered: [], verdict: "weak", fix: "Mention your 3 years at Google." }, ["k"], "question answer")?.fix, null, "a number or a name not in the context is dropped");
  eq(checkVerdict({ covered: [], verdict: "weak", fix: "Say what you would decide and why." }, ["k"], "question answer")?.fix, "Say what you would decide and why.");
  eq(checkVerdict({ covered: [], verdict: "weak", fix: "You worked at a bank, say so." }, ["k"], "question answer")?.fix, null, "no claim about the person");
  eq(checkVerdict({ verdict: "great" }, [], ""), null);
  const rows: any[] = [];
  const admin = { from: (t: string) => ({ insert: async (r: any) => { rows.push({ t, r }); return { error: null }; } }) };
  let sent: any = null;
  const judge = modelJudge(admin, { get: (k) => ({ MODEL_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-test" } as Record<string, string>)[k] }, {
    call: async (payload, meter) => {
      sent = payload;
      meter.calls++; meter.provider = "anthropic"; meter.models.push("claude-haiku-5-5"); meter.input_tokens += 100; meter.output_tokens += 20;
      return { content: [{ type: "text", text: '{"covered":["dense rank"],"verdict":"weak","fix":"Explain the partition step."}' }] };
    },
  });
  const v = await judge({ question: "Q", requirement: "sql", keys: ["dense rank", "partitioned by department"], answer: "dense rank", userId: "u1", threadId: "t1" });
  eq(v, { covered: ["dense rank"], verdict: "weak", fix: "Explain the partition step." });
  assert(/Do not state or guess any fact about the candidate/.test(sent.system) && JSON.parse(sent.messages[0].content).key_points.length === 2);
  eq(rows.length, 1);
  eq([rows[0].t, rows[0].r.user_id, rows[0].r.calls, rows[0].r.provider], ["agent_turn_costs", "u1", 1, "anthropic"]);
  // Through the real gateway on a fake Anthropic Messages wire: the judge's one request goes to api.anthropic.com on the
  // Claude reader model, with the Anthropic key, and no other host is contacted (a gpt id in CAREER_MODEL changes nothing).
  const wire = fakeAnthropic(() => '{"covered":["dense rank"],"verdict":"strong","fix":"Say why."}');
  const rows2: any[] = [];
  const admin2 = { from: (t: string) => ({ insert: async (r: any) => { rows2.push({ t, r }); return { error: null }; } }) };
  const live = modelJudge(admin2, { get: (k) => ({ OPENAI_API_KEY: "sk-openai-not-used", ANTHROPIC_API_KEY: "sk-ant-test", CAREER_MODEL: "gpt-5-mini", MODEL_PROVIDER: "openai" } as Record<string, string>)[k] }, {
    callModel: (cfg, payload, o) => callModel(cfg, payload, { ...o, request: wire.request }),
  });
  eq((await live({ question: "Q", requirement: "sql", keys: ["dense rank"], answer: "dense rank", userId: "u1", threadId: "t1" }))?.verdict, "strong");
  eq([wire.urls, wire.bodies[0].model, wire.headers[0]["x-api-key"], wire.onlyAnthropic()], [["https://api.anthropic.com/v1/messages"], "claude-haiku-5-5", "sk-ant-test", true]);
  eq([rows2[0].r.provider, rows2[0].r.models], ["anthropic", ["claude-haiku-5-5"]]);
  const broken = modelJudge(admin, { get: () => undefined }, { call: () => Promise.reject(new Error("down")) });
  eq(await broken({ question: "Q", requirement: null, keys: [], answer: "a" }), null, "a failed judge leaves the code check standing");
  // D-036: CAREER_MOCK_JUDGE is a release flag: on when unset, and CAREER_MOCK_JUDGE=off (its rollback) means no judge.
  eq(supabaseMockPrep({}, { get: (k) => (k === "CAREER_MOCK_JUDGE" ? "off" : undefined) }).judge, null);
  assert(typeof supabaseMockPrep({}, { get: () => undefined }).judge === "function");
  assert(typeof supabaseMockPrep({}, { get: (k) => (k === "CAREER_MOCK_JUDGE" ? "on" : undefined) }).judge === "function");
});

Deno.test("F11/6 the weak-spot list: newest result per skill wins; a later strong answer clears it; requirements first", () => {
  const ev = (at: string, answers: any[]) => ({ at, kind: "mock_done", subject: "Mock: data analyst at Acme", detail: { role: "data analyst", company: "Acme", answers } });
  const spots = weakSpots([
    ev("2026-10-20T00:00:00Z", [{ skill: "SQL", q: "q1", kind: "technical", req: ["sql"], weak: true }, { skill: "statistics", q: "q2", kind: "technical", req: ["statistics"], weak: true }]),
    ev("2026-10-22T00:00:00Z", [{ skill: "your opener", q: "q0", kind: "opener", req: [], weak: true }, { skill: "SQL", q: "q3", kind: "technical", req: ["sql"], weak: false }, { skill: "A/B testing", q: "q4", kind: "technical", req: ["experimentation"], weak: true }]),
  ]);
  eq(spots.map((s) => s.skill), ["A/B testing", "your opener", "statistics"]);
  eq(weakSpots([]), []);
});

Deno.test("F11/7 the asks: drill and list phrasings; a pasted description under the ask; the mock commands unchanged", () => {
  for (const t of ["drill my weak spots", "Drill my weak spots.", "can you drill my weak areas", "practice my weak spots", "let's work on my weak spots", "quiz me on my weak spots", "drill my weaknesses", "drill my weak spots from my last mock"]) assert(isDrillAsk(t), t);
  for (const t of ["what are my weak spots?", "which are my weak areas", "show my weak spots"]) assert(isWeakListAsk(t), t);
  for (const t of ["what are your weaknesses", "my weak spot is SQL and I want to fix it", "drill", "stop"]) assert(!isDrillAsk(t) && !isWeakListAsk(t), t);
  const p = pastedJd(`mock me for data analyst at Acme\n${JD} ${JD}`);
  eq(p?.ask, "mock me for data analyst at Acme");
  eq(parseMockCommand(p!.ask), { kind: "start", role: "data analyst", company: "Acme", minutes: 20 });
  eq(pastedJd("mock me for data analyst at Acme"), null);
  eq(pastedJd(`I think the interview went fine.\n${JD} ${JD}`), null, "no mock asked on the first line");
  eq(matchPosting([{ company: "Acme Analytics", title: "Software Engineer" }, { company: "Acme Analytics", title: "Data Analyst II" }], { role: "data analyst", company: "Acme" })?.title, "Data Analyst II");
  eq(matchPosting([{ company: "Acme Analytics", title: "Software Engineer" }], { role: "data analyst", company: "Acme" }), null, "another role at the same company is not this posting");
  eq(matchPosting([{ company: "Acmeville", title: "Data Analyst" }], { role: "data analyst", company: "Globex" }), null);
});

Deno.test("F11/8 mockTurn with the hooks: a bound start, a weak answer noted, the debrief's tail, one event, a drill in another thread", async () => {
  const kv = new Map<string, MockState>(); let last: string | null = null; const recorded: any[] = [];
  const prep: MockPrep = {
    posting: async (_u, _t, want) => (/acme/i.test(want.company ?? "") ? { title: "Data Analyst", company: "Acme", job_id: "j1", url: null, source: "application", text: JD } : null),
    history: async () => recorded.map((e, i) => ({ at: new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString(), kind: "mock_done", ...e })).reverse(),
    record: async (_u, e) => { recorded.push(e); },
  };
  const store: MockStore = { get: async (_u, t) => kv.get(t) ?? null, save: async (_u, t, s) => { kv.set(t, s); }, clear: async (_u, t) => { kv.delete(t); }, lastAssistantIntent: async () => last, prep };
  let now = Date.UTC(2026, 9, 25, 12);
  const say = async (message: string, threadId = "t1") => { now += 60_000; const r = await mockTurn({ message, userId: "u", threadId, now, store }); last = r?.intent ?? null; return r!; };
  const s = await say("mock me for data analyst at Acme");
  eq(s.intent, MOCK_INTENT);
  assert(/built from the posting on your applications/.test(s.reply), s.reply);
  let r = await say("I like data a lot and I want this job.");
  assert(/Weak spot noted for a drill\./.test(r.reply), r.reply);
  r = await say("skip");
  assert(!/Weak spot/.test(r.reply.split("\n")[0]), "a skip is not graded");
  r = await say("end mock");
  assert(/Weak spots kept for a drill: your opener\./.test(r.reply) && /Next steps:\n1\. Your opener \(Q1\): /.test(r.reply), r.reply);
  eq(recorded.length, 1);
  eq(recorded[0].detail.answers.map((a: any) => [a.skill, a.weak ?? null, a.skipped ?? false]), [["your opener", true, false], ["SQL", null, true]]);
  const d = await say("drill my weak spots", "t2");
  assert(/^Weak-spot drill: 1 question, one for each weak spot on file: your opener\./.test(d.reply) && /Q1 of 1: Again, sharper this time: Tell me about yourself/.test(d.reply), d.reply);
  // Without hooks the WO-025 mock runs exactly as before: no posting, no grading line, no drill.
  const plain: MockStore = { ...store, prep: undefined };
  const p = await mockTurn({ message: "mock me for data analyst at Acme", userId: "u", threadId: "t3", now, store: plain });
  assert(p && !/built from the posting/.test(p.reply));
  eq(await mockTurn({ message: "drill my weak spots", userId: "u", threadId: "t4", now, store: plain }), null);
  eq(debriefTail({ ...kv.get("t2")!, answers: [] }), "");
});
