// WO-106: real-model transcripts of the slice (resume -> live job links -> one application) and of each fix from the
// 2026-10-21 live test, on the agent brain. Every message goes in the way Telegram delivers it (channel_inbound.runInbound),
// then through the code before the brain that agent-chat runs (the mock interview), then agentTurn with the same tools
// production passes: today's postings read from the real boards, every shown link checked against its board, the apply
// queue, the person's situation. Nothing is faked: no OPENAI_API_KEY, no run. The person is the synthetic test persona
// (Maya), never a real one. What this cannot show: the deployed function itself, Supabase, Telegram's servers.
//   deno run -A evals/career/slice.ts --out evals/career/results/slice-<label>.md [--boards 60]
import boards from "../../supabase/functions/career-ingest/boards.json" with { type: "json" };
import { boardFetchFeed, ingestBoards, matchesWords, memoryPostingsDb, searchWords } from "../../supabase/functions/_shared/career_ingest.ts";
import { runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { mockTurn, type MockState, type MockStore } from "../../supabase/functions/_shared/career_mock.ts";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { callModel, modelConfig, newMeter } from "../../supabase/functions/_shared/model_gateway.ts";
import { careerModelConfig } from "../../supabase/functions/agent-chat/release_model.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { linkChecker } from "../../supabase/functions/_shared/link_check.ts";
import { situationFrom } from "../../supabase/functions/_shared/career_situation.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY. A transcript is never faked."); Deno.exit(2); }
const out: string[] = [];
const say = (s = "") => { out.push(s); console.log(s); };

// 1. Today's postings, from the real boards (the same ingest the career-ingest function runs).
const db = memoryPostingsDb();
const contact = Deno.env.get("INGEST_CONTACT_EMAIL") || "slice transcript run";
const t0 = Date.now();
const stats = await ingestBoards({ boards: boards as any, fetchFeed: boardFetchFeed(fetch, { userAgent: `Trainee job alerts (contact: ${contact})` }), db, now: Date.now(), maxBoards: Number(opt("--boards") || 60), concurrency: 24 });
const open = await db.open();
const search = async (q: string) => { const w = searchWords(q); return open.filter((p) => matchesWords(p as any, w)).slice(0, 150); };
const linkCheck = linkChecker(fetch, { userAgent: `Trainee job link check (contact: ${contact})` });

// 2. The pieces agent-chat passes, in memory.
const host = CareerHost.createCareerHost({ CareerAccess: core.CareerAccess, CareerOnboarding: core.CareerOnboarding, CareerRouter: core.CareerRouter, CareerDoorstep: core.CareerDoorstep, CareerReply: core.CareerReply, CareerContainment: core.CareerContainment });
const cfg = careerModelConfig(Deno.env);
const meter = newMeter();
const wants = memoryWantStore(), alerts = memoryAlertStore();
interface Person { snapshot: any; history: { role: "user" | "assistant"; content: string }[]; last: string | null; mock: Map<string, MockState>; tools: string[] }
const people = new Map<string, Person>();
let clock = Date.now(), lastUser: string | null = null;
const emptyRows = { jobs: [], prepared: [], card: null, questions: [], outreach: [], mail_drafts: [], interviews: [], alerts: null, standing: [], threads: [], connections: [], cloud: null, channel: null, last_search: null, unreadable: [] };

async function chat(a: { userId: string; threadId: string | null; message: string }) {
  const p: Person = people.get(a.userId) ?? { snapshot: null, history: [], last: null, mock: new Map(), tools: [] };
  people.set(a.userId, p); lastUser = a.userId;
  const tid = a.threadId ?? `t-${a.userId}`, now = (clock += 60_000);
  p.tools = [];
  const store: MockStore = {
    get: async (_u, t) => (p.mock.has(t) ? structuredClone(p.mock.get(t)!) : null),
    save: async (_u, t, s) => void p.mock.set(t, structuredClone(s)),
    clear: async (_u, t) => void p.mock.delete(t),
    lastAssistantIntent: async () => p.last,
  };
  const mock = await mockTurn({ message: a.message, userId: a.userId, threadId: tid, now, store });
  let reply: string;
  if (mock) {
    reply = mock.reply; p.last = mock.intent; p.tools.push(`code: mock interview (${mock.status})`);
  } else {
    const ctx: any = host.createTurnCtx({ userId: a.userId, threadId: tid, now, snapshot: p.snapshot });
    const situation = situationFrom({ ...emptyRows, wanted: await wants.list(a.userId) } as any, now);
    const t = await agentTurn({ message: a.message, history: p.history, stores: ctx, userId: a.userId, threadId: tid, now,
      model: (payload) => callModel(cfg, payload, { meter, role: "chat" }), postings: async (q) => { const r = await search(q); p.tools.push(`search "${q}" -> ${r.length} matched`); return r; }, alerts, wants, posting: (id) => db.get(id), linkCheck,
      known: { standing: [], alerts: null, pipeline: null, situation } });
    p.snapshot = host.extractSnapshot(ctx);
    reply = t.reply; p.last = t.show?.intent ?? "agent";
    for (const c of t.tool_calls as any[]) p.tools.push(`${c.name}${c.ok ? "" : " (failed)"}`);
    if (t.stopped === "model_error") p.tools.push("MODEL ERROR");
  }
  p.history.push({ role: "user", content: a.message }, { role: "assistant", content: reply });
  return { status: 200, reply, threadId: tid };
}

// 3. Telegram in: the channel layer every live message goes through.
const world = memoryChannelWorld();
const adapter = telegramAdapter({ token: "transcript", fetch: (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as typeof fetch, sleep: async () => {} });
const sentDirect: string[] = [];
const d = { env: { get: (k: string) => ({ TRAINEE_SIGNUP: "open" } as Record<string, string>)[k] }, now: () => clock, store: world.inbound, render: adapter.render,
  chat, reply: async (_c: string, b: string[]) => { sentDirect.push(b.join("\n")); return { ok: true }; }, deliver: async () => {} };
let mid = 1000;
async function text(chatId: number, t: string, extra: Record<string, unknown> = {}) {
  const before = new Set(world.outbox.keys()), direct = sentDirect.length;
  lastUser = null;
  await runInbound({ provider: "telegram", channel: "telegram", messageId: String(++mid), kind: "text", contact: `tg:${chatId}`, address: String(chatId), text: t, ...extra } as any, d as any);
  const replies = [...world.outbox.entries()].filter(([k]) => !before.has(k)).map(([, r]: any) => r.text);
  return { replies: [...sentDirect.slice(direct), ...replies], tools: lastUser ? people.get(lastUser)?.tools ?? [] : ["channel layer (no brain turn)"] };
}
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
async function verify(urls: string[]) {
  const rows: string[] = [];
  for (const u of urls) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(u, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": `Trainee link check (contact: ${contact})` } });
      await r.body?.cancel();
      rows.push(`| ${u} | ${r.status} | ${r.url !== u ? r.url : "same"} | ${r.status === 200 && !/[?&]error=true/.test(r.url) ? "LIVE" : "NOT LIVE"} |`);
    } catch (e) { rows.push(`| ${u} | no answer | ${(e as Error).message.slice(0, 40)} | UNVERIFIED |`); }
    finally { clearTimeout(timer); }
  }
  return rows;
}
async function scenario(title: string, chatId: number, steps: (string | { command: "start" | "help" })[]) {
  say(`\n## ${title}\n`);
  for (const s of steps) {
    const shown = typeof s === "string" ? s : `/${s.command}`;
    const r = typeof s === "string" ? await text(chatId, s) : await text(chatId, "", { command: s.command });
    say(`**Maya:** ${shown}\n`);
    for (const rep of r.replies) say(`**Trainee:** ${rep.replace(/\n/g, "  \n")}\n`);
    if (!r.replies.length) say("**Trainee:** (no reply)\n");
    say(`<sub>handled by: ${r.tools.join(", ") || "agent (no tools)"}</sub>\n`);
    const urls = [...new Set(r.replies.join("\n").match(URL_RE) ?? [])];
    if (urls.length) { say("| link in the reply | HTTP | ended at | verdict |\n|---|---|---|---|"); for (const row of await verify(urls)) say(row); say(""); }
  }
}

say(`# Slice transcripts (agent brain, ${cfg.model}), ${new Date().toISOString()}`);
say(`Commit: ${Deno.env.get("GITHUB_SHA") ?? "local"}. Boards read: ${stats.attempted} (ok ${stats.boards_ok}, failed ${stats.boards_failed}); open postings: ${open.length}; read in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
say("Each message goes in as Telegram delivers it, through the channel layer and the code before the brain, to the agent brain on the real model. Every link in a reply is fetched again here, after the reply, and its HTTP status is shown.");

const RESUME = `here's my resume:
Maya Chen
Chicago, IL
Experience
Data Analyst, Northbridge Logistics, 2022-2025: built SQL and Tableau dashboards for 40 operations managers; cut weekly reporting from 6 hours to 1.
Skills
SQL, Tableau, Python, Excel
Education
BS Economics, University of Illinois Chicago, 2022
I want a senior data analyst role in Chicago or remote.`;

await scenario("F1: /start, greeting, help, and leaving an interview", 7001, [{ command: "start" }, "hi", "mock me for data analyst at Stripe", "find me data analyst jobs in Chicago", "resume mock", "exit the interview", "help"]);
await scenario("F2: recall of the stored goal, and a correction", 7002, ["I want a senior data analyst role in Chicago", "what's my goal?", "I moved to Denver last month", "what's my goal now?"]);
await scenario("F3 + F4: the goal steers the search; every job has a checked link", 7003, ["I'm a data analyst with 3 years of SQL. I want a senior data analyst role, based in Chicago", "find me jobs"]);
await scenario("F5 + F6: a batch ask and its status, nothing invented", 7004, ["apply to 15 data analyst jobs for me", "how's my batch going?"]);
await scenario("THE SLICE: resume in, live links out, one application queued", 7005, [RESUME, "find me jobs that fit", "apply to the first one", "how's my batch going?"]);

const queued = Object.values(wants.dump()).flat();
say(`\n## The apply queue after the run (career_apply_wanted, in memory)\n`);
say(queued.length ? queued.map((w: any) => `- ${w.title} at ${w.company}: ${w.url} (state: ${w.state})`).join("\n") : "- empty");
say(`\nModel calls: ${meter.calls}, failed: ${meter.failed}, cost $${(meter.usd_micros / 1e6).toFixed(3)}.`);
const file = opt("--out");
if (file) { await Deno.mkdir(new URL(".", `file://${Deno.cwd()}/${file}`), { recursive: true }).catch(() => {}); await Deno.writeTextFile(file, out.join("\n") + "\n"); }
