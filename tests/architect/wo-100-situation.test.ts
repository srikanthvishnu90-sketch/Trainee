// WO-100 (architect): the situation read model. Code builds, every turn, every task in flight with its state, blocker,
// who acts and how; the next steps in a fixed order; what Trainee can do right now; and what could not be read. The agent
// sees it in its prompt and through its tools; "what do you need from me" names everything only the person can do; an
// emailed code typed into chat is removed. Synthetic world (evals/career/worlds/in-flight.json); no network, no spend.
import WORLD from "../../evals/career/worlds/in-flight.json" with { type: "json" };
import SET from "../../evals/career/conversations.json" with { type: "json" };
import { openWorld, USER, worldTurn } from "../../evals/career/world.ts";
import { personBlock, summarizePipeline } from "../../supabase/functions/_shared/agent/memory.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { EVENT_KINDS, memoryEventStore } from "../../supabase/functions/_shared/agent/timeline.ts";
import { questionsTurn } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import HANDLER from "../../supabase/functions/agent-chat/handler-career.ts" with { type: "text" };
// New in WO-100: imported so that each test fails on its own on trunk, rather than the file failing to load.
const S: any = await import("../../supabase/functions/_shared/career_situation.ts").catch(() => null);
const C: any = await import("../../supabase/functions/_shared/career_capabilities.ts").catch(() => null);

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const need = () => { assert(S && C, "career_situation.ts and career_capabilities.ts exist"); };
const world = (o: { fail?: Set<string> } = {}) => openWorld(WORLD, { postings: (SET as any).postings, ...o });
const sitOf = async (o: { fail?: Set<string> } = {}) => { need(); const w = await world(o); return { w, s: await S.readSituation(w.admin, USER, w.now) }; };
const task = (s: any, company: string, kind?: string) => s.tasks.find((t: any) => t.company === company && (!kind || t.kind === kind));
// A scripted model: these tool calls, then a stop.
const script = (...steps: { name: string; input: any }[][]) => { let i = 0; return async () => { const s = steps[i++]; return s ? { content: s.map((x, k) => ({ type: "tool_use", id: `s${i}-${k}`, name: x.name, input: x.input })), stop_reason: "tool_use" } : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; }; };

Deno.test("WO-100/1 each task has its exact state and blocker: Notion's confirmation, Ramp's reason, Airtable stale, Jordan's draft on Gmail", async () => {
  const { s } = await sitOf();
  const notion = task(s, "Notion"), ramp = task(s, "Ramp"), plaid = task(s, "Plaid", "application"), air = task(s, "Airtable"), out = task(s, "Plaid", "outreach");
  assert(notion.state === "confirmed" && notion.evidence.confirmation_id === "NOT-55812" && notion.blocker === null, JSON.stringify(notion));
  assert(ramp.state === "failed" && ramp.evidence.reason === "Phone number is required" && ramp.blocker.who === "person" && /Phone number is required/.test(ramp.blocker.what), JSON.stringify(ramp));
  assert(plaid.state === "needs_user" && plaid.blocker.who === "person" && /code/.test(plaid.blocker.what) && /never in this chat/.test(plaid.blocker.how), JSON.stringify(plaid));
  assert(air.kind === "apply_request" && air.blocker.who === "person" && /has not taken it since 2026-10-17/.test(air.blocker.what), JSON.stringify(air));
  assert(out.title === "email to Jordan Lee (Technical Recruiter)" && out.blocker.who === "person" && /Gmail is not connected/.test(out.blocker.what), JSON.stringify(out));
  assert(task(s, "Brex").state === "queued" && task(s, "Brex").blocker.who === "extension");
  assert(task(s, "Figma", "application").state === "awaiting_approval" && /2 open questions/.test(task(s, "Figma", "application").blocker.what));
  assert(s.tasks.filter((t: any) => t.company === "Plaid" && t.kind !== "outreach").length === 1, "the tracker's Plaid is the queue's Plaid, not a second task");
  assert(s.today.used === 2 && s.today.limit === null, `no pace set: no product daily number (CAPS-1390): ${JSON.stringify(s.today)}`);
  assert(s.goal.roles[0] === "data analyst" && s.goal.constraints[0] === "Needs visa sponsorship (F-1 OPT)");
});

Deno.test("WO-100/2 the next steps come in the fixed order", async () => {
  const { s } = await sitOf();
  const want: [string, RegExp][] = [
    ["person", /^answer 2 questions holding up Figma$/], ["person", /^Plaid \(Business Analyst\): the employer emailed a code; type the code [^;]* never in this chat$/],
    ["person", /^Figma: prepared, waiting for a yes or no$/], ["person", /^email to Jordan Lee \(Technical Recruiter\) \(Plaid\): draft/],
    ["person", /^Airtable \(Analytics Analyst\): the extension has not taken it/], ["person", /^Ramp \(Data Analyst\) was not sent \(Phone number is required\)/],
    ["extension", /^Brex: approved or asked for, waiting to run$/], ["trainee", /^keep watching for data analyst postings/],
  ];
  assert(s.next.length === want.length, JSON.stringify(s.next.map((n: any) => n.what)));
  want.forEach(([who, re], i) => assert(s.next[i].who === who && re.test(s.next[i].what), `step ${i + 1}: ${JSON.stringify(s.next[i])}`));
});

Deno.test("WO-100/3 a table that cannot be read is named and never guessed; the rest still loads", async () => {
  const { s } = await sitOf({ fail: new Set(["career_apply_jobs", "user_oauth_connections"]) });
  assert(s.unreadable.includes("jobs") && s.unreadable.includes("connections"), JSON.stringify(s.unreadable));
  assert(!task(s, "Notion") && task(s, "Airtable") && task(s, "Figma", "application"), "the other sources are read");
  assert(s.capabilities.find((c: any) => c.id === "gmail_send").status === "unknown", "Gmail is not called off when its row could not be read");
  const b = S.situationBlock(s);
  assert(b.includes("Could not be read this turn (never guess these): jobs, connections"), b);
  assert(S.statusText(s, "Notion").includes("could not be read just now: jobs"), "a company missing for a read failure says so");
});

Deno.test("WO-100/4 the block names every company in flight, never files a confirmed one under 'Stopped', and keeps next steps under any budget", async () => {
  const { s } = await sitOf();
  const b = personBlock({ standing: [], alerts: null, pipeline: null, situation: s } as any);
  for (const c of ["Notion", "Plaid", "Ramp", "Brex", "Figma", "Airtable", "Jordan Lee"]) assert(b.includes(c), `${c} named\n${b}`);
  assert(!/Stopped until they help:\n(- [^\n]*\n)*- Notion/.test(b), "Notion is not under 'Stopped'");
  assert(b.includes("Gmail is NOT connected") && b.includes("Never: LinkedIn or Indeed automation"), "capability lines are present");
  const tiny = S.situationBlock(s, 200);
  for (const n of s.next) assert(tiny.includes(n.what), `next step kept under a tiny budget: ${n.what}`);
  assert(/more lines left out for length/.test(tiny), "the cut is said");
  // The pipeline block (kept for callers without a situation) has the same heading fixed.
  const T0 = Date.parse("2026-10-19T15:00:00Z"), iso = (h: number) => new Date(T0 - h * 3600000).toISOString();
  const p = summarizePipeline({ prepared: [], openCard: null, dailyLimit: 25, jobs: [
    { company: "Code Co", url: "https://jobs.example.test/c", state: "needs_user", reason: "email_code", created_at: iso(3), updated_at: iso(3) },
    { company: "Done Co", url: "https://jobs.example.test/d", state: "confirmed", reason: null, created_at: iso(5), updated_at: iso(4) },
  ] }, T0);
  const pb = personBlock({ standing: [], alerts: null, pipeline: p });
  assert(!/Stopped until they help:\n(- [^\n]*\n)*- Done Co/.test(pb), `a confirmed application is not under 'Stopped'\n${pb}`);
});

Deno.test("WO-100/5 'what do you need from me' with no questions open names Plaid's code (not 'Nothing is waiting on you')", async () => {
  const { s, w } = await sitOf();
  const none = { open: async () => [], countOpen: async () => 0, get: async () => [], answer: async () => {}, shown: async () => null, setShown: async () => {}, lastAssistantIntent: async () => null };
  const r = await questionsTurn({ message: "what do you need from me", userId: USER, threadId: "A", now: w.now, store: none, situation: s } as any);
  assert(r && !/Nothing is waiting on you/.test(r.reply) && /Plaid[^\n]*code/.test(r.reply) && /Jordan Lee/.test(r.reply) && /Figma: prepared, waiting for a yes or no/.test(r.reply), r?.reply);
  const q = await questionsTurn({ message: "what do you need from me", userId: USER, threadId: "A", now: w.now, store: w.questionStore as any, situation: s } as any);
  // One question per message (review of #360): the first of the 2, then everything else only the person can do.
  assert(q && /^Question 1 of 2 only you can answer/.test(q.reply) && /\nAre you legally authorized/.test(q.reply) && /Also waiting on you:\n1\. Plaid/.test(q.reply), q?.reply);
  assert(!/Also waiting on you:[\s\S]*answer 2 questions/.test(q!.reply), "the questions are not listed twice");
});

Deno.test("WO-100/6 in a new thread, list_applications shows an application recorded in another thread", async () => {
  const w = await world();
  await worldTurn(w, { brain: "agent", threadId: "A", message: "I also applied to Datadog for the data analyst role today", now: w.now, model: script([{ name: "track_application", input: { company: "Datadog", role: "Data Analyst", stage: "Submitted" } }]) });
  const r = await worldTurn(w, { brain: "agent", threadId: "B", message: "what have I applied to so far?", now: w.now + 60000, model: script([{ name: "list_applications", input: {} }]) });
  const got = r.seen!.results.find((x) => x.tool === "list_applications")!.content;
  for (const c of ["Datadog", "Notion", "Ramp", "Airtable"]) assert(got.includes(c), `${c} listed in thread B: ${got.slice(0, 400)}`);
});

Deno.test("WO-100/7 where_do_i_stand for Ramp gives the failure and its reason", async () => {
  const { s, w } = await sitOf();
  const t = careerTools({ postings: async () => [], mail: w.mail as any, situation: s } as any).find((x) => x.name === "where_do_i_stand")!;
  const r: any = await t.run({ company: "Ramp" }, { userId: USER, threadId: "B", now: w.now, state: {} });
  assert(r.found >= 1 && /Ramp[^\n]*NOT sent[^\n]*Phone number is required/.test(r.text), JSON.stringify(r));
  const n: any = await t.run({ company: "Notion" }, { userId: USER, threadId: "B", now: w.now, state: {} });
  assert(/NOT-55812/.test(n.text), "a confirmed one carries its confirmation id");
});

Deno.test("WO-100/8 a queued application is on the timeline: recall of apply_queued returns Stripe", async () => {
  assert((EVENT_KINDS as readonly string[]).includes("apply_queued"), "apply_queued is an event kind");
  const events = memoryEventStore(), wants = memoryWantStore(), db = memoryPostingsDb();
  const p = (WORLD as any).postings[0];
  await db.putMany([{ ...p, provider: "greenhouse", board: "stripe", last_seen_at: p.first_seen_at, closed_at: null }]);
  const tools = careerTools({ postings: async () => [], events, wants, posting: (id) => db.get(id) });
  const c = { userId: USER, threadId: "A", now: Date.parse(WORLD.now), state: {}, turn: { message: "apply to the Stripe data analyst role", added: [], before: "" } };
  const q: any = await tools.find((x) => x.name === "queue_applications")!.run({ postings: [{ job_id: p.job_id, url: p.url, company: "Stripe", title: "Data Analyst" }] }, c as any);
  assert(q.queued === 1, JSON.stringify(q));
  const r: any = await tools.find((x) => x.name === "recall")!.run({ kinds: ["apply_queued"] }, c as any);
  assert(r.count === 1 && JSON.stringify(r.events[0].detail.companies) === '["Stripe"]', JSON.stringify(r));
});

Deno.test("WO-100/9 'the second one' resolves from the last list shown, in another thread", async () => {
  need();
  const w = await world();
  const a = await worldTurn(w, { brain: "agent", threadId: "A", message: "find me data analyst jobs in chicago", now: w.now, model: script([{ name: "search_jobs", input: { query: "data analyst chicago" } }]) });
  const shown = JSON.parse(a.seen!.results.find((x) => x.tool === "search_jobs")!.content).postings;
  const b = await worldTurn(w, { brain: "agent", threadId: "B", message: "apply to the second one you showed me", now: w.now + 60000, model: script() });
  assert(b.situation.last_shown?.items[1]?.job_id === shown[1].job_id, JSON.stringify(b.situation.last_shown));
  assert(b.seen!.system.includes(`2. ${shown[1].company}, ${shown[1].title} (${shown[1].job_id})`), "the list is in thread B's prompt, in order");
});

Deno.test("WO-100/10 with no Google grant, every agent prompt says Gmail is NOT connected", async () => {
  need();
  const w = await world();
  for (const [i, m] of ["hi", "what can you do?", "draft a follow-up to the Plaid recruiter"].entries()) {
    const r = await worldTurn(w, { brain: "agent", threadId: "A", message: m, now: w.now + i * 60000, model: script() });
    assert(r.seen!.system.includes("Gmail is NOT connected"), `prompt for "${m}"`);
    assert(/SITUATION[\s\S]*the truth about their tasks/.test(r.seen!.system) && /Never say something was sent, submitted, connected or done/.test(r.seen!.system), "the prompt's situation rules");
  }
});

Deno.test("WO-100/11 a bare code is removed only while an emailed code is pending", () => {
  const msg = "Plaid emailed me a code, it's 482913";
  assert(redactIdentity(msg).text === msg, "no code pending: unchanged (a bare number stays a number)");
  const r = (redactIdentity as any)(msg, { codePending: true });
  assert(!r.text.includes("482913") && r.removed.includes("code"), JSON.stringify(r));
  for (const keep of ["call me at 312-555-0100", "I have 2 years of SQL", "my salary floor is 85,000", "order 12345"]) {
    assert((redactIdentity as any)(keep, { codePending: true }).text === keep, `kept: ${keep}`);
  }
});

Deno.test("WO-100/12 the router's 'what's connected' answers from the live grants, the extension and the phone link", async () => {
  need();
  const w = await world();
  const r = await worldTurn(w, { brain: "router", threadId: "A", message: "what's connected", now: w.now });
  assert(!/Nothing is connected yet/.test(r.reply) && /Texting: connected/.test(r.reply), r.reply);
  const g = await openWorld({ ...WORLD, connections: [{ provider: "google_career", scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"], connected_at: "2026-10-01T00:00:00Z" }] }, { postings: (SET as any).postings });
  const s = await S.readSituation(g.admin, USER, g.now);
  assert(s.capabilities.find((c: any) => c.id === "gmail_send").status === "on" && /draft to Jordan Lee[^;]*waits for a yes$/.test(task(s, "Plaid", "outreach").blocker.what), "with send granted, the draft waits only on their yes");
  const recs = C.statusRecordsFrom(s.capabilities);
  assert(recs[0].provider === "google_career" && recs[0].scopes.length === 2 && !JSON.stringify(recs).includes("@"), JSON.stringify(recs));
  assert(C.NEVER.map((c: any) => c.id).join() === "linkedin_indeed,captcha,secrets");
});

Deno.test("WO-100/13 the handler reads the situation once, before the card, and hands it to every reader", () => {
  const read = HANDLER.indexOf("readSituation(admin, user.id"), card = HANDLER.indexOf("await cardTurn(");
  assert(read > 0 && read < card && HANDLER.split("readSituation(").length === 2, "one read, before the card handler");
  assert(read < HANDLER.indexOf("chatInput(rawMessage"), "before the chat input, so a pending code is redacted");
  assert(/questionsTurn\(\{[^}]*situation/.test(HANDLER) && /situation \}, memory/.test(HANDLER) && /statusRecordsFrom\(situation\.capabilities\)/.test(HANDLER), "questions, the agent and the router get it");
  assert(!HANDLER.includes("readPipeline"), "readPipeline is replaced");
});

Deno.test("WO-100/15 the eval sees the world: C27-C41 and 30 held-out paraphrases run through the seeded dispatch", async () => {
  const flight = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/in-flight.json", import.meta.url)));
  assert(flight.items.map((i: any) => i.id).join() === Array.from({ length: 15 }, (_, i) => `C${27 + i}`).join(), "C27-C41");
  assert(flight.heldout.length >= 30 && flight.items.every((i: any) => i.turns.some((t: any) => t.must?.length)), "30 held-out; every item graded");
  const { worldBrain } = await import("../../evals/career/run-conversations.ts");
  const items = flight.items.filter((i: any) => i.id === "C35");
  const brain = await worldBrain({ kind: "agent", world: WORLD, postings: (SET as any).postings, items, model: script([{ name: "where_do_i_stand", input: { company: "Datadog" } }]) });
  const r = await brain(items[0].turns.map((t: any) => t.user));
  assert(r.replies.length === 3, "a reply per turn, in the threads the item names");
});

Deno.test("WO-100/14 apply_queued is allowed by the database and shipped by go-live in order", () => {
  const root = new URL("../../", import.meta.url);
  const sql = Deno.readTextFileSync(new URL("supabase/migrations/20261023100000_career_events_apply_queued.sql", root));
  for (const k of EVENT_KINDS) assert(sql.includes(`'${k}'`), `the check keeps ${k}`);
  assert((sql.match(/'apply_queued'/g) ?? []).length >= 2, "the check and career_recall_own both take apply_queued");
  const live = Deno.readTextFileSync(new URL("scripts/launch/trainee-go-live.sh", root));
  assert(live.indexOf("20261022150000_career_apply_authority.sql") < live.indexOf("20261023100000_career_events_apply_queued.sql"), "after the latest migration");
  assert(/apply_queued/.test(live.slice(live.indexOf("MIGRATION_MARK=("), live.indexOf("EARLIER="))), "with a mark query");
  assert(Deno.readTextFileSync(new URL("tests/db/run.sh", root)).includes("career_events_apply_queued.test.sql"));
});
