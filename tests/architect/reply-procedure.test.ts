// REPLY PROCEDURE (owner, 2026-11-01: "make sure the agent actually knows how to respond in a conversation similar to
// Claude/Instinct, same grammar process"). The procedure (_shared/agent/reply_procedure.ts, written from the owner's response
// brief Parts 5 and 8) is in the brain's system prompt and the reply writer's rules; on Telegram the router's reply is held
// to its shape in code. Twenty multi-turn conversations, in process over the eval world (evals/career/world.ts: the handler's
// order over in-memory stores; no network, no model):
//
//   B01-B10  the staged brain's turns (stagedDecision takes each graded message), through agentTurn with a fake model. The
//            fake answers by the procedure only when its system prompt carries the procedure, and otherwise the way an
//            unguided model texts (markdown, a wall of sentences, two questions, an action it never took). Each checks the
//            prompt holds all eight steps, the earlier turns reach the model, and the reply meets the procedure.
//   R01-R10  the router's turns, multi-turn, its final reply held to the procedure's shape (shapeByProcedure, as agent-chat
//            does on Telegram) and checked: at most three sentences a message, no markdown, at most one question, no action
//            claimed, never a link first; and not one word added, dropped or changed by the shaping.
//
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/reply-procedure.test.ts
import assertNode from "node:assert/strict";
import { openWorld, USER, worldTurn } from "../../evals/career/world.ts";
import { procedureParts, procedureProblems, REPLY_PROCEDURE, sentencesIn, shapeByProcedure } from "../../supabase/functions/_shared/agent/reply_procedure.ts";
import { writerPayload } from "../../supabase/functions/_shared/career_reply_writer.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const WORLD = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const seed = () => ({ now: WORLD.now, postings: WORLD.postings, facts: WORLD.facts, standing: WORLD.standing, tracked: WORLD.tracked });
// The eight steps, by what each one asks for (the procedure's own wording may change; these meanings may not).
const STEPS: [string, RegExp][] = [
  ["1 read the whole message", /read the whole message/i],
  ["2 chat-sized vs file", /chat-sized answer[\s\S]*one plain message[\s\S]*file or page[\s\S]*link follows as its own message[\s\S]*never write a URL yourself/i],
  ["3 first sentence answers or corrects with numbers", /first sentence answers[\s\S]*correct it with the actual numbers/i],
  ["4 one idea, three sentences, no markdown, register", /one idea per message, at most three sentences[\s\S]*no markdown[\s\S]*match their register/i],
  ["5 unknowns named", /unverified or unknown/i],
  ["6 one question only when a wrong guess costs", /at most one question[\s\S]*wrong guess would cost/i],
  ["7 one concrete next step", /one concrete next step/i],
  ["8 never claim an action not taken", /never say something happened unless a tool did it/i],
];
// Every word and link of a reply, as a sorted multiset: shaping may move a link to its own line, never add, drop or change a word.
const words = (s: string) => (s.match(/https?:\/\/\S+?(?=[)\].,;:]*(?:\s|$))|[A-Za-z0-9$%@']+/g) ?? []).sort();

// ------------------------------------------------------------------------------------------------ B: the staged brain
interface BrainCase { id: string; prior: string[]; msg: string; good: string; check?: (r: string) => void }
// What an unguided model texts: the shape the procedure exists to prevent.
const UNGUIDED = "**Great question!** Here's the thing. There are many factors. It depends on your goals. Some people do it. Others don't. " +
  "Would you like me to research it? Or should I just send your application? I've sent a note to the recruiter.";
const BRAIN: BrainCase[] = [
  { id: "B01", prior: ["my goal is a data analyst job in chicago"], msg: "is it worth getting a masters for data science",
    good: "For a data analyst job in Chicago, usually not first: most postings ask for SQL and a bachelor's, not a master's.\n\nI haven't checked what these programs cost you or their placement rates, so that part is unknown.\n\nWant me to pull the requirements from live Chicago analyst postings?" },
  { id: "B02", prior: ["hi"], msg: "im stressed, 40 applications and no interviews",
    good: "That's rough, and 40 with no interviews usually points at the resume or the roles, not at you.\n\nI can't see which roles those 40 were, so I don't know yet which it is.\n\nSend me two of the postings and I'll compare them to your resume." },
  { id: "B03", prior: ["my goal is a software engineering internship"], msg: "should i take the startup offer or wait for google",
    good: "Take the offer you have unless Google has given you a date: a maybe can't beat a yes.\n\nI don't know the startup's deadline or Google's stage for you.\n\nWhen does the startup need an answer?" },
  { id: "B04", prior: ["hi", "my goal is a product manager role"], msg: "how do i explain a gap year in interviews",
    good: "Say it in one line and move on: what you did, what it gave you, why you're ready now.\n\nInterviewers mostly check that the gap is explained, not how long it was.\n\nTell me what you did that year and I'll draft the line with you." },
  { id: "B05", prior: ["my goal is a data analyst job in chicago"], msg: "will i make 150k as a new grad analyst lol",
    good: "Probably not: new grad analyst postings in Chicago that list pay mostly sit well under $150k.\n\nI haven't pulled this week's ranges, so take that as a rough read, not a number.\n\nI'll check the live Chicago postings for their listed pay next." },
  { id: "B06", prior: ["hi"], msg: "whats the difference between a data analyst and a data scientist",
    good: "Analysts answer questions with data you already have; scientists build models to predict or decide things.\n\nIn postings that shows up as SQL and dashboards versus Python, statistics and experiments.\n\nWant me to show you one posting of each?" },
  { id: "B07", prior: ["my goal is a marketing internship in nyc"], msg: "is it bad that my resume is 2 pages",
    good: "For an internship, yes, usually: one page reads faster and most students fit on one.\n\nI'm assuming this is for the marketing internships in New York on your goal.\n\nSend it and I'll mark what to cut first." },
  { id: "B08", prior: ["hi", "my goal is a backend engineering job"], msg: "is leetcode even worth it",
    good: "For backend roles at bigger companies, yes: most still run a coding screen.\n\nSmaller companies often use a take-home instead, so it depends on where you apply.\n\nI'll look at which of your target companies list a coding screen." },
  { id: "B09", prior: ["my goal is a ux design job in austin"], msg: "should i put my gpa on my resume its a 3.1",
    good: "Leave it off: a 3.1 doesn't help, and most design postings don't ask for it.\n\nIf an application form asks, give it honestly.\n\nWant me to check whether any of your saved postings ask for a GPA?" },
  { id: "B10", prior: ["hi", "my goal is a finance analyst role in chicago"], msg: "how do i follow up after an interview without being annoying",
    good: "Send one short thank-you within a day, then one check-in a week after the date they gave you.\n\nKeep each to two lines: thanks, one specific thing you liked, still interested.\n\nTell me who interviewed you and I'll draft the thank-you for your OK." },
];

for (const c of BRAIN) {
  Deno.test(`${c.id} staged brain: the procedure is in the prompt, the conversation reaches the model, and the reply meets it: "${c.msg}"`, async () => {
    const w = await openWorld(seed());
    let now = w.now;
    for (const p of c.prior) { await worldTurn(w, { brain: "router", threadId: "A", message: p, now }); now += 90000; }
    // The staged release takes this turn (career_staged.ts: question, advice and conversation turns go to the brain).
    const { stagedDecision } = await import("../../supabase/functions/agent-chat/career_staged.ts");
    const t = w.th("A");
    const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now, accountPersistence: true, snapshot: t.snapshot, account: w.account, postings: w.kb });
    const d = stagedDecision({ env: { get: (k: string) => (k === "CAREER_BRAIN" ? "staged" : undefined) }, message: c.msg, ctx, host: w.H, structured: false });
    assert(d.brain, `${c.id}: the staged brain takes "${c.msg}" (${d.reason})`);
    let system = "", messages: any[] = [];
    const model = async (p: any) => {
      system ||= p.system; messages = p.messages;
      const guided = system.includes(REPLY_PROCEDURE);
      return { content: [{ type: "text", text: guided ? c.good : UNGUIDED }], stop_reason: "end_turn" };
    };
    const r = await worldTurn(w, { brain: "agent", threadId: "A", message: c.msg, now, model });
    for (const [step, re] of STEPS) assert(re.test(system), `${c.id}: the brain's prompt has step ${step}`);
    const said = JSON.stringify(messages);
    for (const p of c.prior) assert(said.includes(p), `${c.id}: the earlier turn "${p}" reaches the model`);
    assert(said.includes(c.msg), `${c.id}: the message itself reaches the model`);
    eq(procedureProblems(r.reply), [], `${c.id}: the reply meets the procedure: ${r.reply}`);
    eq(r.reply.trim(), c.good, `${c.id}: the brain's reply goes out as composed`);
  });
}

Deno.test("the unguided reply fails the procedure on every count the checks hold (the checks are not vacuous)", () => {
  const p = procedureProblems(UNGUIDED);
  for (const k of ["markdown", "a message of", "questions", "claims an action"]) assert(p.some((x) => x.includes(k)), `${k}: ${JSON.stringify(p)}`);
});

Deno.test("the reply writer (the router's output rewritten in the texting voice) carries the procedure", () => {
  const payload = writerPayload({ said: "Your tracker holds 1 application.", tasks: [], next: [], effects: { sent: 0, queued: 0 } } as any, "where are my apps", "telegram");
  for (const [step, re] of STEPS) assert(re.test(String(payload.system)), `the writer's rules have step ${step}`);
});

// ------------------------------------------------------------------------------------------------ R: the router
interface RouterCase { id: string; turns: string[]; expect?: RegExp }
const ROUTER: RouterCase[] = [
  { id: "R01", turns: ["hi"], expect: /^Hi/ },
  { id: "R02", turns: ["hi", "what can you do"] },
  { id: "R03", turns: ["my goal is a data analyst job in chicago", "whats my goal?"], expect: /^Your career goal, in your words: a data analyst job in chicago\./ },
  { id: "R04", turns: ["find me data analyst jobs in chicago"], expect: /\nhttps:\/\/\S+(?:\n|$)/ },
  { id: "R05", turns: ["my goal is a data analyst job in chicago", "how should i prep for a behavioral interview"] },
  { id: "R06", turns: ["hi", "thanks"] },
  { id: "R07", turns: ["how much do data analysts make in chicago"], expect: /won't guess a number/ },
  { id: "R08", turns: ["hi", "where are my applications"], expect: /^Your tracker holds 1 application\./ },
  { id: "R09", turns: ["can you help me write a cover letter"] },
  { id: "R10", turns: ["my goal is a data analyst job in chicago", "what do you know about me"] },
];
const PARITY: Record<string, string> = { R01: "R12", R04: "R04", R05: "R02", R06: "R12" };
for (const c of ROUTER) {
  Deno.test(`${c.id}${PARITY[c.id] ? ` parity audit ${PARITY[c.id]}` : ""} router: "${c.turns.join(" → ")}" held to the procedure's shape, every word kept`, async () => {
    const w = await openWorld(seed());
    let now = w.now, r: Awaited<ReturnType<typeof worldTurn>> | null = null;
    for (const m of c.turns) { r = await worldTurn(w, { brain: "router", threadId: "A", message: m, now }); now += 90000; }
    const raw = r!.reply, shaped = shapeByProcedure(raw);
    eq(procedureProblems(shaped), [], `${c.id}: the reply meets the procedure: ${JSON.stringify(shaped)}`);
    eq(words(shaped), words(raw.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 $2")), `${c.id}: the shaping adds, drops and changes no word`);
    for (const p of shaped.split(/\n\s*\n/)) assert(sentencesIn(p).length <= 3 || /^\s*(?:\d{1,3}[.)]|•)\s/m.test(p), `${c.id}: one message of at most three sentences: ${p}`);
    if (c.expect) assert(c.expect.test(shaped), `${c.id}: ${shaped}`);
  });
}

Deno.test("shapeByProcedure: a long paragraph splits into messages of three sentences; markdown goes; a card's rows stay whole; a short answer is untouched", () => {
  eq(shapeByProcedure("One. Two. Three. Four. Five."), "One. Two. Three.\n\nFour. Five.");
  eq(shapeByProcedure("**Yes**, it went through on Oct 30. No reply yet."), "Yes, it went through on Oct 30. No reply yet.");
  eq(shapeByProcedure("Read [the posting](https://x.test/1) first."), "Read the posting first.\n\nhttps://x.test/1");
  eq(shapeByProcedure("## Next\n- one\n- two"), "Next\n• one\n• two");
  const card = "1. Name: TEST Person\n2. Email: test@example.test\n3. Start: June. Says it twice. Then more. And more.";
  eq(shapeByProcedure(card), card, "a card's rows are never split");
});

// ------------------------------------------------------------------------------------------------ the parity audit's rows
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { shapeForTurn } from "../../supabase/functions/_shared/channel_shape.ts";

// A clock the test moves; timers fire in order as it advances.
function clock() {
  let t = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    now: () => t,
    set: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, e] of q) if (e.at <= end && (best === null || e.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const e = q.get(best)!; q.delete(best); t = e.at; e.fn(); await settle();
      }
      t = end; await settle();
    },
  };
}
// The Telegram webhook over memory stores, a chat that takes turnMs, and every call to Telegram recorded with its time.
async function telegramTurn(message: string, turnMs: number) {
  const TOKEN = "123456:parity-audit-token-PPPPPPPP", SECRET = "p".repeat(40), CHAT = "7031";
  const W = memoryChannelWorld(), T = clock(), ev: { what: string; at: number; text?: string }[] = [];
  let n = 0;
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === `${TELEGRAM_API}/bot${TOKEN}/sendChatAction`) { ev.push({ what: "typing", at: T.now() }); return Response.json({ ok: true, result: true }); }
    if (url === `${TELEGRAM_API}/bot${TOKEN}/sendMessage`) { ev.push({ what: "send", at: T.now(), text: body.text }); return Response.json({ ok: true, result: { message_id: ++n } }); }
    return Response.json({ ok: false, error_code: 400, description: "not expected here" }, { status: 400 });
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = { TRAINEE_SIGNUP: "open", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "ParityAuditBot" };
  const env = { get: (k: string) => vars[k] || undefined };
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => 0, sleep: async () => {} });
  const answer = "Three Chicago internships match, newest first.";
  const chat = async () => { ev.push({ what: "chat:start", at: T.now() }); await T.advance(turnMs); ev.push({ what: "chat:end", at: T.now() }); return { status: 200, reply: answer, threadId: "t1" }; };
  const deliver = async (a: { userId: string; key: string }) => { const st = W.delivery({ only: { userId: a.userId, key: a.key } }); const r = await deliverDue({ store: st, adapters, now: 1_000_000 }); await st.release(); return r; };
  const res = await handleTelegram(new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: 9001, message: { message_id: 9001, from: { id: Number(CHAT), is_bot: false }, chat: { id: Number(CHAT), type: "private" }, date: 1, text: message } }) }),
    { env, now: () => 1_000_000, store: () => W.inbound, chat, deliver, adapter: () => adapters.telegram!, timers: { set: T.set, clear: T.clear } } as any);
  await res.body?.cancel();
  return { ev, sends: ev.filter((e) => e.what === "send").map((e) => e.text!), answer };
}

Deno.test("parity audit R01 (expected): typing at once and refreshed; past ~6 s exactly one interim naming the action, claiming no result; then the answer", async () => {
  const r = await telegramTurn("find me SWE internships in Chicago", 9000);
  eq(r.ev[0].what, "typing", "typing before anything else");
  assert(r.ev.findIndex((e) => e.what === "typing") < r.ev.findIndex((e) => e.what === "chat:start"), "typing before the turn starts");
  assert(r.ev.filter((e) => e.what === "typing" && e.at > 0).length >= 1, "typing refreshed while the turn runs");
  eq(r.sends.length, 2, `one interim, then the answer: ${JSON.stringify(r.sends)}`);
  assert(/^on it — looking for roles now$/i.test(r.sends[0]), `the interim names the action: ${r.sends[0]}`);
  assert(!/\b(found|sent|submitted|applied|done|here (?:are|is))\b|\d/i.test(r.sends[0]), `the interim claims no result: ${r.sends[0]}`);
  eq(r.sends[1], r.answer);
});
Deno.test("parity audit R01 (negative): never 'one sec', never two interims on a very slow turn, none on a one-line answer", async () => {
  const slow = await telegramTurn("find me SWE internships in Chicago", 30000);
  eq(slow.sends.filter((t) => /^on it/i.test(t)).length, 1, `one interim, never two: ${JSON.stringify(slow.sends)}`);
  assert(!slow.sends.some((t) => /one sec|one moment|hang on/i.test(t)), "no contentless interim");
  const quick = await telegramTurn("thanks", 300);
  eq(quick.sends, [quick.answer], "a one-line answer gets no acknowledgment");
});

Deno.test("parity audit R02: a two-idea answer arrives as separate bubbles of at most three sentences; never split inside a sentence or a link; no part counters on iMessage/SMS", async () => {
  const reply = "That role wants SQL and dashboards, which you have. It also asks for Tableau, which isn't on your resume yet. The pay isn't listed. They posted it Monday.\n\n" +
    "Separately, your Acme application is still waiting on them. Here's the posting: https://boards.example.test/acme/jobs/1?src=trainee&ref=abc. I'll check it again tomorrow.";
  const shaped = shapeByProcedure(reply);
  eq(procedureProblems(shaped), [], shaped);
  // Each part is its own outbox row, so its own message on every channel; each part through the channel's render as well.
  const env = { get: (k: string) => ({ LOOPMESSAGE_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t" } as Record<string, string>)[k] };
  const ad = adaptersFromEnv(env, { fetch: (async () => { throw new TypeError("no network"); }) as any, clock: () => 0, sleep: async () => {} });
  const parts = procedureParts(reply) ?? [];
  for (const ch of ["imessage", "telegram"] as const) eq(parts.flatMap((p) => ad[ch]!.render(p)).length >= parts.length, true, ch);
  const bubbles = parts.flatMap((p) => ad.imessage!.render(p));
  assert(!bubbles.some((b) => /:\./.test(b)), `no stray mark where the link was: ${JSON.stringify(bubbles)}`);
  assert(bubbles.length >= 3, `separate bubbles: ${JSON.stringify(bubbles)}`);
  for (const b of bubbles) {
    assert(/^https?:\/\/\S+$/.test(b) || sentencesIn(b).length <= 3, `at most three sentences: ${b}`);
    assert(/^https?:\/\/\S+$/.test(b) || /[.!?)]$/.test(b.trim()), `never cut inside a sentence: ${JSON.stringify(b)}`);
    assert(!/(?:^|\s)\(?\d+\s*\/\s*\d+\)/.test(b), `no part counter: ${b}`);
  }
  assert(bubbles.includes("https://boards.example.test/acme/jobs/1?src=trainee&ref=abc"), `the link whole, in its own bubble: ${JSON.stringify(bubbles)}`);
  const ideas = bubbles.findIndex((b) => /^Separately/.test(b));
  assert(ideas > 0 && !bubbles[ideas - 1].includes("Separately"), "the second idea starts its own bubble");
});

Deno.test("parity audit R03: a structured answer on iMessage/SMS is plain text; no literal **, # or backticks", async () => {
  const md = "## Your week\n**3 applications** went out. Use `Apply` on each role.\n\n- Acme: submitted\n- Beta: waiting on you\n- Gamma: closed";
  const shaped = shapeByProcedure(md);
  const env = { get: (k: string) => ({ LOOPMESSAGE_API_KEY: "k" } as Record<string, string>)[k] };
  const im = adaptersFromEnv(env, { fetch: (async () => { throw new TypeError("no network"); }) as any, clock: () => 0, sleep: async () => {} }).imessage!;
  for (const b of im.render(shaped)) assert(!/\*\*|`|^\s*#/m.test(b), `no visible markdown: ${JSON.stringify(b)}`);
  eq(procedureProblems(md).includes("markdown"), true, "the raw text is caught (the check is not vacuous)");
  eq(procedureProblems(shaped).includes("markdown"), false, shaped);
});

Deno.test("parity audit R04: one summary line, then each link alone; a URL the model wrote is never sent, only one a tool returned", () => {
  const minted = "https://boards.greenhouse.io/acme/jobs/1";
  const written = "Found 2 Chicago roles; pay is listed on one. See https://jobs.invented.test/fake-listing for the rest, and the Acme one here: " + minted;
  const sh = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: written, allowedLinks: [minted] });
  const links = sh.shape?.links ?? [];
  assert(!sh.reply.includes("jobs.invented.test") && !links.some((l) => l.includes("jobs.invented.test")), `the model-written URL is not sent: ${JSON.stringify(sh)}`);
  assert(links.includes(minted) || sh.reply.includes(minted), `the tool's link is kept: ${JSON.stringify(sh)}`);
  eq(procedureProblems("Found 2 Chicago roles, see https://x.test/1 for them.").includes("a link inside a sentence"), true, "a link mid-sentence is caught");
  eq(procedureProblems(shapeByProcedure("Found 2 Chicago roles, see https://x.test/1 for them.")), [], "and held to its own line by the shaping");
});

Deno.test("parity audit R05: a role set is never a wall of rows in chat; the procedure sends structure to a File with one summary line", () => {
  const wall = "Here are your roles:\n1. Data Analyst, Acme, Chicago\n2. Data Analyst, Beta, Chicago\n3. BI Analyst, Gamma, remote\n4. Analyst, Delta, Chicago\n5. Analyst, Epsilon, Chicago\n6. Analyst, Zeta, remote";
  assert(procedureProblems(wall).some((p) => /wall of 6 rows/.test(p)), JSON.stringify(procedureProblems(wall)));
  eq(procedureProblems("Found 6 live roles for data analyst in Chicago, 2 new this week; pay where the posting lists it.\nhttps://files.example.test/f?t=abc"), [], "summary line + the link alone");
  assert(/file or page, never a wall of rows in chat/i.test(REPLY_PROCEDURE) && /the system adds them/i.test(REPLY_PROCEDURE), "the brain is told: structure goes to a File, links are added by code");
});

Deno.test("parity audit R12: a short casual message gets a short casual answer; one warm beat at most; no filler opener, no 'as an AI', no exclamation strings", async () => {
  for (const turns of [["hey"], ["hi", "thanks"], ["hi", "lol ok"]]) {
    const w = await openWorld(seed());
    let now = w.now, r: Awaited<ReturnType<typeof worldTurn>> | null = null;
    for (const m of turns) { r = await worldTurn(w, { brain: "router", threadId: "A", message: m, now }); now += 90000; }
    const shaped = shapeByProcedure(r!.reply);
    eq(procedureProblems(shaped), [], `${turns.join(" → ")}: ${shaped}`);
    assert(shaped.length <= 320 && sentencesIn(shaped.replace(/\n/g, " ")).length <= 3, `short: ${shaped}`);
  }
  for (const bad of ["Absolutely!!! So glad that helped.", "As an AI, I'm glad to help.", "Great question! Here's the deal.", "Awesome! Love that! Let's go!"]) {
    assert(procedureProblems(bad).some((p) => /exclamation|as an AI|filler/.test(p)), `caught: ${bad} ${JSON.stringify(procedureProblems(bad))}`);
  }
  assert(/one warm beat at most/i.test(REPLY_PROCEDURE) && /no "as an AI"/i.test(REPLY_PROCEDURE) && /exclamation/i.test(REPLY_PROCEDURE), "the brain is told");
});
