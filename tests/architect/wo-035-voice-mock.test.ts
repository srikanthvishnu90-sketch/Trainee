// WO-035: the voice mock interview, and interview patterns for 50 firms. "start a voice mock for Goldman IB" answers with
// owner directive 2026-11-02 (Claude-only, no OpenAI anywhere): voice is OFF and is a hard NOT_WIRED whatever the
// environment holds (CAREER_VOICE=on included): no link is issued, "start" mints nothing and contacts no host, the text mock
// is offered. The debrief scorer, the session store and the 50 firms' patterns (each cite a public URL and a checked date)
// are unchanged.
// Run: deno test -A --no-check tests/architect/wo-035-voice-mock.test.ts
import {
  answersFromTranscript,
  findFirm,
  findRecord,
  firms,
  MOCK_VOICE_INTENT,
  type MockState,
  type MockStore,
  mockTurn,
  parseMockCommand,
  patternProblems,
  recordFacts,
  start,
  type Turn,
  voiceDebrief,
  voiceStartText,
} from "../../supabase/functions/_shared/career_mock.ts";
import {
  handleVoice,
  interviewerInstructions,
  NOT_WIRED_TEXT,
  supabaseVoiceSessions,
  type VoiceRow,
  type VoiceSessions,
} from "../../supabase/functions/_shared/career_voice.ts";
import { LINK_TTL_MS, signToken, supabaseVoiceLinks, verifyToken, voiceWired } from "../../supabase/functions/_shared/career_voice_link.ts";
import { CareerPrep } from "../../supabase/functions/_shared/router_core.career.js";
import { HYGIENE } from "../../evals/career/compare.ts";
import PATTERNS from "../../packages/career-data/interview-patterns.json" with { type: "json" };
import HANDLER from "../../supabase/functions/_shared/career_voice.ts" with { type: "text" };
import LINK_SRC from "../../supabase/functions/_shared/career_voice_link.ts" with { type: "text" };
import INDEX from "../../supabase/functions/career-voice/index.ts" with { type: "text" };
import PAGE from "../../voice/mock.html" with { type: "text" };
import MIGRATION from "../../supabase/migrations/20261021020000_career_voice_mock.sql" with { type: "text" };
import CONFIG from "../../supabase/config.toml" with { type: "text" };

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const T = Date.parse("2026-10-21T15:00:00Z");
const MIN = 60_000;
const KEY = "service-role-key-for-tests-only-0123456789abcdef";
const OPENAI_KEY = "sk-test-REAL-KEY-must-never-leave-the-server-0123456789";
const USER = "00000000-0000-4000-8000-000000000351", OTHER = "00000000-0000-4000-8000-000000000352";
const SID = "00000000-0000-4000-8000-0000000003a1";
const THREAD = "00000000-0000-4000-8000-0000000003b1";
const env = (o: Record<string, string>) => (k: string) => o[k];
const quotes = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/\.\.\.$/, ""));
const hygieneOk = (r: string, where: string) => { for (const h of HYGIENE) assert(!h.test(r), `${where}: ${h.what}\n${r}`); };

// The voice session table's rules, in memory (the SQL is tested in tests/db/career_voice_mock.test.sql): one start per
// link, within 10 minutes; one debrief per started call, within its window; one move to the text mock.
function memSessions(state: MockState, o: { user?: string; created?: number; started?: boolean } = {}) {
  const created = o.created ?? T;
  const row: VoiceRow & { call_expires_at?: string } = { thread: THREAD, state, link_expires_at: new Date(created + LINK_TTL_MS).toISOString() };
  if (o.started) { row.started_at = new Date(created).toISOString(); row.call_expires_at = new Date(created + 35 * MIN).toISOString(); }
  const calls: string[] = [];
  const stored: { fn: string; args: Record<string, unknown> }[] = [];
  const owner = o.user ?? USER;
  const s: VoiceSessions = {
    read: async (u, id) => (u === owner && id === SID ? structuredClone(row) : null),
    start: async (u, id, now, mins) => {
      calls.push("start");
      if (u !== owner || id !== SID || row.started_at || row.fallback_at || Date.parse(row.link_expires_at) <= now) return null;
      row.started_at = new Date(now).toISOString();
      row.call_expires_at = new Date(now + mins * MIN).toISOString();
      return structuredClone(row.state);
    },
    finish: async (u, id, text, now) => {
      calls.push("finish");
      stored.push({ fn: "finish", args: { u, id, text } });
      if (u !== owner || !row.started_at || row.debriefed_at || row.fallback_at || Date.parse(row.call_expires_at!) < now) return false;
      row.debriefed_at = new Date(now).toISOString();
      return true;
    },
    fallback: async (u, id, st, text, now) => {
      calls.push("fallback");
      stored.push({ fn: "fallback", args: { u, id, state: st, text } });
      if (u !== owner || row.debriefed_at || row.fallback_at) return false;
      if (!row.started_at && Date.parse(row.link_expires_at) <= now) return false;
      row.fallback_at = new Date(now).toISOString();
      return true;
    },
  };
  return { s, row, calls, stored };
}
// Voice contacts no host at all: fetch is replaced for the whole file, and every test that goes through call() asserts it
// was never used.
const fetched: string[] = [];
globalThis.fetch = ((u: unknown) => { fetched.push(String(u)); return Promise.reject(new Error("no network in voice tests")); }) as typeof fetch;
async function call(body: unknown, d: { sessions: VoiceSessions; env?: Record<string, string>; now?: number; delivered?: string[]; logs?: string[] }) {
  const res = await handleVoice(new Request("https://fn.test/career-voice", { method: "POST", body: JSON.stringify(body) }), {
    env: env(d.env ?? { SUPABASE_SERVICE_ROLE_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: "sk-ant-test", CAREER_VOICE: "on" }),
    now: () => d.now ?? T,
    cors: {},
    sessions: d.sessions,
    deliver: async (_u, key) => void d.delivered?.push(key),
    log: (l) => void d.logs?.push(l),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), sent: fetched };
}
const callToken = (o: { exp?: number } = {}) => signToken({ s: SID, u: USER, k: "call", exp: o.exp ?? T + 50 * MIN }, KEY);
const startToken = (o: { exp?: number; user?: string; key?: string } = {}) =>
  signToken({ s: SID, u: o.user ?? USER, k: "start", exp: o.exp ?? T + LINK_TTL_MS }, o.key ?? KEY);
const goldman = () => ({ ...start({ role: "IB", company: "Goldman", now: T }).state, voice: true });

// A 20-minute call: six planned questions, each answered for about three minutes (about 450 spoken words), one follow-up
// each, and the interviewer's own words, which must never be scored or quoted.
const INTERVIEWER_TELL = "Interesting, tell me more about the zebra committee";
const SENTENCES = [
  "At my last internship I built the weekly pipeline model in Excel and Python for 40 deals.",
  "First I split the work with two analysts, then I checked every input against the filings.",
  "The result was a review time cut from 6 hours to 2, and the team kept the template.",
  "I learned to say what I would decide and why, and what would change my mind.",
  "We missed one deadline early on, so I set up a checklist that we used every Friday.",
];
function answer(n: number, words = 450): string {
  const out: string[] = [];
  let i = n, count = 0;
  while (count < words) { const s = SENTENCES[i++ % SENTENCES.length]; out.push(s); count += s.split(" ").length; }
  return out.join(" ");
}
function call20(st: MockState): Turn[] {
  const turns: Turn[] = [{ who: "interviewer", text: "Hi, I'm your interviewer for today's practice. Ready?" }, { who: "candidate", text: "Yes, ready when you are." }];
  for (const q of st.questions) {
    turns.push({ who: "interviewer", text: `Question ${q.n}. ${q.q}` });
    turns.push({ who: "candidate", text: answer(q.n, 380) });
    turns.push({ who: "interviewer", text: `${INTERVIEWER_TELL}. What exactly was your part?` });
    turns.push({ who: "candidate", text: answer(q.n + 2, 70) });
  }
  turns.push({ who: "interviewer", text: "That's the end of the practice. Hang up, and your debrief will come by text." });
  return turns;
}

Deno.test("WO-035/1 the texts that ask for a voice mock; the text mock and the carrier words are unchanged", () => {
  eq(parseMockCommand("start a voice mock for Goldman IB"), { kind: "voice", role: "IB", company: "Goldman", minutes: 20 });
  eq(parseMockCommand("voice mock me for data analyst at Stripe"), { kind: "voice", role: "data analyst", company: "Stripe", minutes: 20 });
  eq(parseMockCommand("start a 15 minute voice mock interview for software engineer at Meta"), { kind: "voice", role: "software engineer", company: "Meta", minutes: 15 });
  eq(parseMockCommand("Start a mock interview by voice."), { kind: "voice", role: "", company: null, minutes: 20 });
  eq(parseMockCommand("mock me for Goldman IB"), { kind: "start", role: "IB", company: "Goldman", minutes: 20 }, "the company named first works for the text mock too");
  eq(parseMockCommand("mock me for data analyst at Stripe"), { kind: "start", role: "data analyst", company: "Stripe", minutes: 20 });
  for (const t of ["stop", "end", "start", "voice", "voice memo", "what is a voice mock?", "send a voice note"]) eq(parseMockCommand(t), null, t);
});

Deno.test("WO-035/2 voice is off: no start link is issued, whatever the environment holds", async () => {
  const kv: { fn: string; args: any }[] = [];
  const admin = { rpc: async (fn: string, args: any) => (kv.push({ fn, args }), { data: SID, error: null }) };
  const links = supabaseVoiceLinks(admin, env({ SUPABASE_SERVICE_ROLE_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: "sk-ant-test", CAREER_VOICE: "on", UPMORE_APP_URL: "https://app.example.test" }));
  const store: MockStore = {
    get: async () => null, save: async () => {}, clear: async () => {}, lastAssistantIntent: async () => null, voice: links,
  };
  const r = await mockTurn({ message: "start a voice mock for Goldman IB", userId: USER, threadId: THREAD, now: T, store });
  assert(r && r.status === "voice_not_wired" && r.intent === MOCK_VOICE_INTENT, JSON.stringify(r));
  assert(/Voice is not available/.test(r.reply) && /text "mock me for IB at Goldman Sachs/.test(r.reply), r.reply);
  assert(!/https?:\/\//.test(r.reply), "no link");
  hygieneOk(r.reply, "voice off");
  eq(kv.length, 0, "no session row is created while voice is off");
  const text = start({ role: "IB", company: "Goldman", now: T }).state;
  for (const e of [{ SUPABASE_SERVICE_ROLE_KEY: KEY, CAREER_VOICE: "on" }, { SUPABASE_SERVICE_ROLE_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY, CAREER_VOICE: "on" }, {}]) {
    eq(await supabaseVoiceLinks(admin, env(e)).create(USER, THREAD, text, T), { ok: false, reason: "not_wired" });
  }
  eq(voiceWired(env({ SUPABASE_SERVICE_ROLE_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: "sk-ant-test", CAREER_VOICE: "on" })), { ok: false, reason: "voice is off: no provider", missing: ["voice is off: no provider"] });
  eq(kv.length, 0);
  // No voice rail at all: same one-line offer.
  const off = await mockTurn({ message: "start a voice mock for Goldman IB", userId: USER, threadId: THREAD, now: T, store: { ...store, voice: undefined } });
  assert(off && off.status === "voice_not_wired" && /Voice is not available/.test(off.reply), off?.reply);
  // The start text for every company on file and a few without: one link line, plain, one message (the text builder is unchanged).
  for (const c of [...firms().map((f) => f.name), "Acme Widgets", null]) {
    const st = { ...start({ role: "software engineer", company: c, now: T }).state, voice: true };
    const t = voiceStartText(st, "https://app.example.test/voice/mock#t=v1.abc.def");
    assert(t.length <= 1500 && t.split("\n")[1] === "https://app.example.test/voice/mock#t=v1.abc.def", t);
    hygieneOk(t, `voice start ${c}`);
  }
});

Deno.test("WO-035/3 start is a hard NOT_WIRED even with CAREER_VOICE=on and every key set: nothing minted, no host contacted", async () => {
  const m = memSessions(goldman());
  fetched.length = 0;
  for (const bad of [undefined, "", "v1.x.y", await startToken({ key: "forged-with-another-key-0123456789abcdef" })]) {
    const r = await call({ action: "start", token: bad }, { sessions: m.s });
    assert(r.status === 401 && r.body.status === "REFUSED", `refused: ${r.text}`);
  }
  eq(m.calls, [], "a bad link never touches the store");
  const logs: string[] = [];
  const r = await call({ action: "start", token: await startToken() }, { sessions: m.s, logs });
  eq([r.status, r.body.status, r.body.text_mock, r.body.message], [200, "NOT_WIRED", true, NOT_WIRED_TEXT], r.text);
  assert(!("client_secret" in r.body) && !("call_token" in r.body) && !("calls_url" in r.body), r.text);
  assert(!r.text.includes(OPENAI_KEY) && !r.text.includes(KEY) && !r.text.includes("sk-ant"), "no key in the response");
  assert(logs.some((l) => l.includes("voice is off: no provider")), logs.join("|"));
  eq(m.calls, [], "the link is not used up");
  eq(fetched, [], "no host is contacted: not OpenAI, not Anthropic, not anyone");
  assert(NOT_WIRED_TEXT.startsWith("Voice is not available"), "honest text");
});

Deno.test("WO-035/4 an expired or foreign link is refused", async () => {
  const token = await startToken();
  const m2 = memSessions(goldman());
  const late = await call({ action: "start", token }, { sessions: m2.s, now: T + LINK_TTL_MS });
  eq([late.status, late.body.reason], [410, "expired"], "the signed expiry");
  eq(m2.calls, [], "an expired link never reaches the store");
  const theirs = await call({ action: "start", token: await signToken({ s: SID, u: OTHER, k: "start", exp: T + LINK_TTL_MS }, KEY) }, { sessions: memSessions(goldman()).s });
  eq(theirs.body.status, "NOT_WIRED", "a valid link of any person gets the same off answer");
  const call2 = await call({ action: "start", token: await callToken() }, { sessions: memSessions(goldman()).s });
  eq([call2.status, call2.body.status], [401, "REFUSED"], "a call token never opens a call");
});

Deno.test("WO-035/5 the text mock in one tap; the page is inert and says voice is not available", async () => {
  const m = memSessions(goldman());
  const fb = await call({ action: "fallback", token: await startToken() }, { sessions: m.s, env: { SUPABASE_SERVICE_ROLE_KEY: KEY } });
  eq(fb.body.status, "OK", fb.text);
  const f = m.stored.find((x) => x.fn === "fallback")!.args as any;
  eq([f.state.role, f.state.company, f.state.status, f.state.questions.length], ["IB", "Goldman Sachs", "running", 6]);
  assert(/^Here is the text mock instead\.\n\nMock interview: IB mock for Goldman Sachs\. About 20 minutes, 6 questions, by text\. /.test(f.text), f.text);
  hygieneOk(f.text, "fallback");
  eq((await call({ action: "fallback", token: await startToken() }, { sessions: m.s })).body.status, "REFUSED", "once");
  assert(PAGE.includes("Voice is not available") && PAGE.includes('action: "fallback"'), "page: not available, text mock offered");
  assert(!/getUserMedia|RTCPeerConnection|realtime|openai/i.test(PAGE.replace(/<!--[\s\S]*?-->/, "")), "the page never asks for the microphone or opens a call");
});

Deno.test("WO-035/6 the interviewer: the same plan, a follow-up at most, and only the record's facts with their fields", () => {
  const st = goldman();
  const ins = interviewerInstructions(st);
  for (const q of st.questions) assert(ins.includes(`Question ${q.n}. ${q.q}`), `question ${q.n} as written`);
  assert(ins.indexOf("Question 1.") < ins.indexOf("Question 6."), "in order");
  assert(/one short follow-up/.test(ins) && /Never invent facts about the person/.test(ins) && /real interview/.test(ins), ins);
  const rec = findRecord("Goldman")!;
  const raw = JSON.stringify(rec).replace(/\s+/g, " ");
  const factLines = ins.split("\n").filter((l) => l.startsWith("- "));
  assert(factLines.length >= 2, ins);
  for (const l of factLines) {
    assert(/^- (interview_styles|process_stages|screening_signals): "/.test(l), `each fact cites its record field: ${l}`);
    for (const q of quotes(l)) assert(raw.includes(q.replace(/\s+/g, " ")), `quoted from the record: ${q}`);
  }
  eq(recordFacts(rec).length, factLines.length);
  // A firm without a record: its sourced patterns only. No record at all: nothing about the company.
  const meta = interviewerInstructions(start({ role: "software engineer", company: "Meta", now: T }).state);
  assert(/interview-patterns\.json, firm meta/.test(meta) && meta.includes("https://www.metacareers.com/"), meta);
  const acme = interviewerInstructions(start({ role: "data analyst", company: "Acme Widgets", now: T }).state);
  assert(/There is no record of Acme Widgets on file\. Say nothing about how Acme Widgets hires or interviews/.test(acme) && !acme.includes("\n- "), acme);
});

Deno.test("WO-035/7 the debrief uses the rubric and quotes only the person's words in the transcript", () => {
  const st = goldman();
  const turns = call20(st);
  const mine = turns.filter((t) => t.who === "candidate").map((t) => t.text).join(" ");
  const r = voiceDebrief(st, turns, T + 20 * MIN);
  eq(r.reached, 6);
  assert(/^Debrief, IB voice mock for Goldman Sachs: 6 of 6 answered\. Average [\d.]+ of 15 \(a practice score, not a hiring prediction\)\./.test(r.reply), r.reply);
  // The same rubric as the text mock: each score is 127's scoreAnswer over that question's own words.
  const { answers } = answersFromTranscript(st.questions, turns);
  for (const p of r.debrief.per_question) eq(p.score, (CareerPrep.scoreAnswer(answers.get(p.n)!) as any).scores.total, `Q${p.n}`);
  for (const q of quotes(r.reply.split("Practice next:")[0])) assert(mine.includes(q), `quoted words are the person's own: "${q}"`);
  assert(!r.reply.includes("zebra"), "the interviewer's words are never quoted or scored");
  assert(r.reply.length <= 1500, `${r.reply.length} characters`);
  hygieneOk(r.reply, "voice debrief");
  // Hung up after Q2: only what the call reached is scored; a real interview is never scored (D-015).
  const short = voiceDebrief(st, [...call20(st).slice(0, 8), { who: "interviewer", text: "Question 3. Next one." }, { who: "candidate", text: "I'm in my real interview right now, what do I say?" }], T);
  eq([short.reached, short.debrief.answered, short.debrief.skipped], [3, 2, 1]);
  assert(!short.reply.includes("real interview right now"), short.reply);
  // Without "Question N." the interviewer asking the planned words still counts.
  const plain: Turn[] = st.questions.flatMap((q) => [{ who: "interviewer", text: `Okay. ${q.q}` } as Turn, { who: "candidate", text: answer(q.n, 60) } as Turn]);
  eq(voiceDebrief(st, plain, T).reached, 6);
});

Deno.test("WO-035/8 no audio is persisted: the code never records or uploads it, and storage gets the debrief only", async () => {
  for (const [name, src] of [["career_voice.ts", HANDLER], ["career-voice/index.ts", INDEX], ["voice/mock.html", PAGE], ["migration", MIGRATION]] as const) {
    assert(!/MediaRecorder|audio\/(?:webm|wav|ogg|mpeg)|\.wav\b|\bBlob\(|storage\.from\(|createSignedUploadUrl|base64.{0,20}audio/i.test(src), `${name} never records or uploads audio`);
  }
  assert(!/\baudio\b[^\n]*\b(?:bytea|text|jsonb)\b/i.test(MIGRATION) && !/transcript\s+(?:text|jsonb)/i.test(MIGRATION), "no audio or transcript column");
  // Every storage call of a whole call, through the Supabase store.
  const st = goldman();
  const turns = call20(st);
  const ops: { op: string; args: unknown }[] = [];
  const row = { thread: THREAD, state: st, link_expires_at: new Date(T + LINK_TTL_MS).toISOString(), started_at: new Date(T).toISOString() };
  const chain = (table: string) => {
    const c: any = { select: () => c, eq: () => c, maybeSingle: async () => (ops.push({ op: `${table}.read`, args: null }), { data: { value: row }, error: null }) };
    for (const w of ["insert", "upsert", "update", "delete"]) c[w] = (args: unknown) => (ops.push({ op: `${table}.${w}`, args }), c);
    return c;
  };
  const admin = {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, unknown>) => (ops.push({ op: fn, args }), { data: fn === "career_voice_start" ? st : true, error: null }),
  };
  const sessions = supabaseVoiceSessions(admin);
  const r = await call({ action: "finish", token: await callToken(), transcript: turns }, { sessions });
  eq(r.body.status, "OK", r.text);
  const writes = ops.filter((o) => o.op !== "career_watch_kv.read");
  eq(writes.map((o) => o.op), ["career_voice_finish"], "the only write: the debrief");
  const stored = JSON.stringify(writes);
  assert(!/audio|recording|"transcript"/i.test(stored), "nothing named audio or transcript is stored");
  assert(!stored.includes("zebra") && !stored.includes(turns[0].text), "the interviewer's words are not stored");
  const text = String((writes[0].args as any).p_text);
  assert(text.startsWith("Debrief, IB voice mock for Goldman Sachs"), text);
  for (const t of turns.filter((x) => x.who === "candidate")) assert(!stored.includes(t.text) || t.text.length <= 110, "no answer is stored whole, only short quotes in the debrief");
  // A turn carrying anything but words is refused.
  const m = memSessions(goldman(), { started: true });
  const bad = await call({ action: "finish", token: await callToken(), transcript: [{ who: "candidate", text: "hi", audio: "UklGRiQAAABXQVZF" }] }, { sessions: m.s });
  eq([bad.status, bad.body.reason], [400, "bad_transcript"]);
});

Deno.test("WO-035/9 the 2-minute debrief path, timed offline on a 20-minute call", async () => {
  const st = goldman();
  const turns = call20(st);
  const words = turns.filter((t) => t.who === "candidate").reduce((n, t) => n + t.text.split(" ").length, 0);
  assert(words >= 2700, `about 20 minutes of speech at 150 words a minute: ${words} words`);
  const m = memSessions(st, { started: true });
  const delivered: string[] = [], logs: string[] = [];
  const t0 = performance.now();
  const r = await call({ action: "finish", token: await callToken(), transcript: turns, latency: { silence_to_audio_ms: [640, 720, 810], vad_to_audio_ms: [310, 350, 420] } },
    { sessions: m.s, now: T + 20 * MIN, delivered, logs });
  const ms = performance.now() - t0;
  eq(r.body.status, "OK", r.text);
  eq(delivered, [`mock:${SID}`], "sent at once when the texting channel is wired (otherwise the next per-minute delivery run)");
  console.log(`WO-035 timing: hang-up to debrief posted ${ms.toFixed(1)} ms (scoring ${r.body.debrief_ms} ms) for ${words} words`);
  assert(ms < 10_000, `${ms} ms: far inside the 2 minutes, which leave room for one delivery run (60 s)`);
  eq(r.body.latency.silence_to_audio, { n: 3, median_ms: 720, p90_ms: 810 });
  assert(logs.some((l) => /reply delay after silence n=3 median=720/.test(l)), "the harness's numbers reach the function log");
  // Once only: a second post of the same call is refused.
  eq((await call({ action: "finish", token: await callToken(), transcript: turns }, { sessions: m.s, now: T + 21 * MIN })).body.reason, "done");
  // A call token that has expired posts nothing.
  const late = await call({ action: "finish", token: await callToken(), transcript: turns }, { sessions: memSessions(st, { started: true }).s, now: T + 60 * MIN });
  eq(late.body.reason, "expired");
});

Deno.test("WO-035/10 the 50 firms: every pattern and question cites a public URL and a checked date", () => {
  const data = PATTERNS as any;
  const ids = new Set(firms().filter((f) => f.record).map((f) => f.record as string));
  eq(patternProblems(data, ids), [], "the file on disk");
  eq(data.firms.length, 50);
  eq(data.firms.filter((f: any) => f.record).length, 33, "33 with a full record");
  // A firm question with no URL, a pattern with no checked date, a firm with nothing sourced: each is a problem.
  const broken = structuredClone(data);
  broken.firms.find((f: any) => f.id === "meta").questions.push({ q: "Tell me about a time you moved fast.", source_type: "reported", checked: "2026-10-20" });
  broken.firms.find((f: any) => f.id === "apple").patterns[0].checked = "";
  broken.firms.find((f: any) => f.id === "optiver").patterns = [];
  eq(patternProblems(broken, ids), [
    "apple.patterns[0]: no checked date",
    "meta.questions[0]: no public https source_url",
    "optiver: no record and no sourced pattern",
  ]);
  // Every one of the 50 gets a sourced company question in a mock: from its record, or from its own patterns.
  let sourced = 0;
  for (const f of data.firms) {
    const st = start({ role: "software engineer", company: f.name.split(/\s+[—–-]\s+|\s*\(|,/)[0], now: T }).state;
    const cq = st.questions.find((q) => q.kind === "company");
    if (cq && /\((?:official|posting|reported|anecdotal|public page|source on file)[^)]*\d{4}-\d{2}-\d{2}\)/.test(cq.q)) sourced++;
    else throw new Error(`${f.id}: no sourced company question: ${JSON.stringify(st.questions.map((q) => q.kind))}`);
  }
  eq(sourced, 50);
  // Exact matching: Citadel is not Citadel Securities; a near name is nobody.
  eq([findFirm("Citadel")?.id, findRecord("Citadel")], ["citadel", null]);
  eq(findFirm("Citadel Securities")?.record, "citadel-securities");
  for (const n of ["Bain Capital", "Meta Financial", "Apple Bank", "Acme Widgets"]) eq(findFirm(n), null, n);
  const meta = start({ role: "software engineer", company: "Meta", now: T });
  const q = meta.state.questions.find((x) => x.kind === "company")!;
  assert(q.q.startsWith("What is on file about Meta's interviews (official, metacareers.com, 2026-10-19): \""), q.q);
  for (const x of quotes(q.q)) assert(JSON.stringify(data).includes(x), `quoted from the file: ${x}`);
  assert(/Q4 comes from sourced notes on how Meta interviews \(checked 2026-10-19\)\./.test(meta.reply), meta.reply);
});

Deno.test("WO-035/11 wiring: the function is deployed without a JWT, CORS limited to the app, the migration's rules", () => {
  assert(/\[functions\.career-voice\]\nverify_jwt = false/.test(CONFIG), "verify_jwt off: the signed link is the gate");
  assert(INDEX.includes("corsFor(req)"), "CORS");
  const code = (t: string) => t.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const [name, src] of [["career_voice.ts", HANDLER], ["career-voice/index.ts", INDEX], ["voice/mock.html", PAGE], ["career_voice_link.ts", LINK_SRC]] as const) {
    assert(!/openai|anthropic|realtime|gpt-|OPENAI_API_KEY|ANTHROPIC_API_KEY|client_secrets|mint/i.test(code(src)), `${name} names no provider and mints nothing`);
  }
  for (const fn of ["career_voice_create", "career_voice_start", "career_voice_finish", "career_voice_fallback"]) {
    assert(MIGRATION.includes(`create or replace function public.${fn}(`), fn);
  }
  assert(/'link_expires_at', p_now \+ interval '10 minutes'/.test(MIGRATION), "10 minutes to start");
  assert(/value->>'started_at' is null and value->>'fallback_at' is null/.test(MIGRATION), "single use");
  assert(/kind in \('alert', 'report', 'reply', 'receipt', 'card', 'status', 'followup', 'mock'\)/.test(MIGRATION), "the outbox takes the debrief");
  assert(/grant execute on function[\s\S]*to service_role;\s*$/.test(MIGRATION) && /from public, anon, authenticated;/.test(MIGRATION), "service role only");
  assert(PAGE.includes("#t=") || PAGE.includes("location.hash"), "the token is read from the fragment, never sent to the web host");
});
