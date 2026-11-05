// C01 (beta 2026-11-04): "three realistic job links" was killed by Supabase Edge with HTTP 546 "CPU Time exceeded"
// (2,142 ms CPU, 53.5 MB; the limit is about 2 s) before any model call. This is the reproduction and the regression test:
// the production handler (supabase/functions/agent-chat/handler-career.ts handleChat) runs unchanged on a real Postgres
// (CI's migration order) with the real supabase-js client (tests/flow/handler.ts), a scripted model on the Anthropic wire,
// and the 600-posting discovery pool the live loader reads (career_kb_postings, _shared/career_pool.js DEFAULT_LIMIT), in a
// conversation that already holds a profile, searches and a watch, as the beta's Telegram thread did.
//
// The turn's stage clock (agent-chat/turn_clock.ts) logs the synchronous CPU of each stage; this test reads that line and
// fails when a C01-style turn's synchronous work passes BUDGET_FRACTION of the Edge limit (the local machine is faster than an
// Edge isolate, so the fraction leaves the live headroom), and, independent of machine speed, when a turn parses a posting
// text more than once (the hot path C01 died in: the router re-parsed all 600 postings on every rank).
//
// Run: CI=true PGBIN=... deno test -A --no-check [--import-map=tests/flow/supabase-npm.json] tests/architect/c01-cpu-budget-pg.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { EDGE_CPU_LIMIT_MS, turnClock } from "../../supabase/functions/agent-chat/turn_clock.ts";
// The same module instance the handler imports (one URL, one instance): its posting parse memos are reset for the cold turn.
import { CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000c0101";
const PEOPLE: Record<string, string> = { "c01-1": PERSON };
// The synchronous work a C01 turn may spend, as a fraction of the Edge CPU limit, measured on this machine.
// A fresh isolate's turn (cold parse memos) is held to it. Before this fix the same turn spent ~800-1,000 ms here (it died at
// 2,142 ms live); after it ~200-350 ms cold and ~80-90 ms warm. 0.35 (700 ms) leaves a CI runner up to ~2x slower than the
// machine these were measured on, and still fails the pre-fix code by a wide margin.
export const BUDGET_FRACTION = 0.35;
const COLD_RUNS = 3;

// ------------------------------------------------------------------------------------------------ the 600-posting pool
const FAMILIES = [
  ["Data Analyst", "SQL, Excel and Tableau dashboards for the operations team"], ["Software Engineer", "TypeScript and Go services on Kubernetes"],
  ["Registered Nurse", "patient care on a medical-surgical unit"], ["Retail Sales Associate", "customer service on the sales floor"],
  ["Marketing Coordinator", "campaign calendars, email and social reporting"], ["Financial Analyst", "forecasting, variance analysis and FP&A models"],
  ["Customer Success Manager", "onboarding and renewals for mid-market accounts"], ["Product Manager", "roadmaps, discovery and launch plans"],
  ["Administrative Assistant", "calendars, travel and office operations"], ["Business Analyst", "requirements, process maps and stakeholder reviews"],
  ["Data Engineer", "Python, Airflow and dbt pipelines on Snowflake"], ["Help Desk Technician", "tier 1 support, tickets and device setup"],
];
const LEVELS = ["", "Junior ", "Senior ", "Entry Level ", "Associate ", "Lead "];
const PLACES = ["Chicago, IL", "New York, NY", "Austin, TX", "Remote", "Seattle, WA", "Denver, CO", "Atlanta, GA", "Boston, MA", "Remote - US", "San Francisco, CA"];
function excerpt(i: number, title: string, what: string): string {
  // ~1.3 KB of HTML, like the board excerpts the loader strips (career_pool.js mapKbPosting).
  const para = `<p>TEST Employer ${i} is hiring a ${title} to own ${what}. You will partner with peers across the business, ` +
    `write clear updates, and improve how the team works every quarter.</p><ul><li>2+ years of experience or equivalent coursework</li>` +
    `<li>Strong written communication and attention to detail</li><li>Comfort with ambiguity and shifting priorities</li></ul>` +
    `<p>Benefits include medical, dental, vision, 401(k) matching, paid time off and a learning budget. Pay range $${55 + (i % 40)},000 - $${80 + (i % 50)},000.</p>`;
  return (para + para.replace(/<p>TEST Employer/, "<p>Our team at TEST Employer")).slice(0, 1400);
}
const POOL = 600; // _shared/career_pool.js DEFAULT_LIMIT
async function seedPool(pg: Pg, n = POOL) {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const [fam, what] = FAMILIES[i % FAMILIES.length];
    const title = `${LEVELS[i % LEVELS.length]}${fam}`;
    const loc = PLACES[(i * 7) % PLACES.length];
    const day = String(1 + (i % 28)).padStart(2, "0");
    rows.push(`('kb-c01-${i}', 'greenhouse', 'c01kb${i % 30}', 'TEST Employer ${i}', '${title}', '${loc}', 'https://boards.example.test/c01/${i}', ` +
      `'2026-10-${day}T00:00:00Z', '2026-10-30', '2026-10', '${excerpt(i, title, what).replace(/'/g, "''")}', 'c01-${i}')`);
  }
  await pg.sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, fetched_on, corpus_vintage, text_excerpt, content_hash) values ${rows.join(",\n")}`);
}

// ------------------------------------------------------------------------------------------------ the scripted model
const model = { calls: 0 };
function scripted(_chat: any): Response {
  model.calls++;
  return new Response(JSON.stringify({ id: "test", model: "test", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Here is what I found." } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
}

// ------------------------------------------------------------------------------------------------ the stage lines
type CpuLine = { evt: string; sync_ms: number; stages: Record<string, number | { ms: number; n: number }>; waits: Record<string, number | { ms: number; n: number }>; intent?: string | null; handler?: string | null };
const lines: CpuLine[] = [];
const rawLog = console.log;
console.log = (...a: unknown[]) => {
  if (typeof a[0] === "string" && a[0].startsWith('{"evt":"agent_chat_')) { try { const l = JSON.parse(a[0]); if (l.evt === "agent_chat_cpu") { lines.push(l); return; } } catch { /* not ours */ } }
  rawLog(...a);
};
const ms = (v: number | { ms: number } | undefined) => typeof v === "number" ? v : v?.ms ?? 0;

let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
async function world() {
  if (handler) return handler;
  pg = await startPg();
  await supabaseParity(pg);
  await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test'); insert into public.profiles (id) values ('${PERSON}');
    insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  await seedPool(pg);
  handler = await careerHandler(pg, PEOPLE);
  const dbl = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/")) {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
      return anthropicWire(new Request(url, { method: "POST", body: String(raw) }), (chat) => scripted(chat));
    }
    return dbl(input as any, init);
  }) as typeof fetch;
  return handler;
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the C01 CPU budget test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const T = { sanitizeResources: false, sanitizeOps: false };

// The beta's thread: a confirmed resume, a couple of searches and a watch before the C01 ask.
const HISTORY = [
  `here is my resume:\n${RESUME}`, "yes, that's my resume",
  "find me data analyst jobs in Chicago", "show me remote business analyst roles", "watch data analyst roles in Chicago",
];
// C01 and its neighbours: asks for a few realistic postings with links.
export const C01_ASKS = [
  "Find me three realistic job links I could apply to this week. Do not apply or submit anything.",
  "send me 3 real job links for entry level data analyst roles in Chicago",
  "can you give me three realistic jobs with links that fit my resume?",
];

Deno.test({ name: "c01: a three-job-links turn on a 600-posting pool stays inside the CPU budget, and every stage is named", ...T, async fn() {
  if (skip()) return;
  const h = await world();
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");
  Deno.env.delete("CAREER_BRAIN");
  Deno.env.delete("CAREER_JUDGE");
  const chat = h.chat("c01-1");
  for (const m of HISTORY) { const t = await chat.say(m); assert(t.status === 200, `history turn answered: ${t.status} ${t.reply}`); }
  const report: string[] = [];
  let worst = 0, parsedCold = 0;
  for (const ask of C01_ASKS) {
    // Once to compile the code path (V8's first call is not the turn's work), then measured: "cold" with the posting parse
    // memos emptied, as a fresh Edge isolate starts (the budget holds the least of COLD_RUNS, so a busy machine's one slow
    // sample is not read as the turn's cost), and "warm" with the memos as the cold turn left them.
    await chat.say(ask);
    let coldMin = Infinity;
    for (const kind of [...Array(COLD_RUNS).fill("cold"), "warm"]) {
      if (kind === "cold") (CareerTailor as any).resetParseMemos();
      lines.length = 0;
      const t = await chat.say(ask);
      assert(t.status === 200, `the C01 turn answered: ${t.status} ${t.reply}`);
      const line = lines.at(-1);
      assert(line, "the turn logged its stage line (agent_chat_cpu)");
      if (kind === "cold") coldMin = Math.min(coldMin, line!.sync_ms);
      // Bounded work, whatever the machine: a cold turn parses each posting text at most once, a warm turn parses none.
      const parsed = (CareerTailor as any).parseMemoStats().parsed;
      if (kind === "cold") assert(parsed <= POOL, `a cold C01 turn parsed ${parsed} posting texts, more than the ${POOL} in the pool`);
      else assert(parsed === parsedCold, `a warm C01 turn parsed ${parsed - parsedCold} posting texts again`);
      parsedCold = parsed;
      report.push(`${kind} ${line!.sync_ms.toFixed(1).padStart(7)} ms sync  intent=${line!.intent} handler=${line!.handler}  stages=${JSON.stringify(line!.stages)} waits=${JSON.stringify(line!.waits)}`);
      // The line names stages only: no message words, no posting.
      const raw = JSON.stringify(line);
      assert(!/realistic|Chicago|TEST Employer|resume/i.test(raw), `the stage line carries no message or posting text: ${raw}`);
    }
    worst = Math.max(worst, coldMin);
  }
  rawLog(`C01 CPU per turn (budget ${BUDGET_FRACTION * EDGE_CPU_LIMIT_MS} ms of ${EDGE_CPU_LIMIT_MS}):\n${report.join("\n")}`);
  assert(worst <= BUDGET_FRACTION * EDGE_CPU_LIMIT_MS, `a C01 turn spent ${worst.toFixed(1)} ms of synchronous work, over ${BUDGET_FRACTION * EDGE_CPU_LIMIT_MS} ms (${BUDGET_FRACTION} of the ${EDGE_CPU_LIMIT_MS} ms Edge limit):\n${report.join("\n")}`);
} });

Deno.test("c01: the stage clock logs one line per turn, starts are logged past the progress mark, a nested stage counts once", () => {
  const out: string[] = [];
  let t = 0;
  const clock = turnClock({ log: (l) => out.push(l), now: () => t, progressFromMs: 100 });
  clock.sync("router", () => { t += 60; });
  clock.sync("router", () => { t += 50; clock.sync("inner", () => { t += 5; }); });
  assert(out.length === 0, `nothing logged before the mark: ${out}`);
  clock.sync("search", () => { t += 1; });
  const start = JSON.parse(out[0]);
  assert(start.evt === "agent_chat_stage_start" && start.stage === "search" && start.sync_ms === 115, out[0]);
  let threw = false;
  try { clock.sync("respond", () => { t += 2; throw new Error("boom"); }); } catch { threw = true; }
  assert(threw, "a stage's error is the caller's");
  clock.flush({ intent: "career_discovery", handler: "CareerRouter" });
  clock.flush({ intent: "again" });
  const lines = out.filter((l) => l.includes('"agent_chat_cpu"'));
  assert(lines.length === 1, `one summary line: ${out.join("\n")}`);
  const sum = JSON.parse(lines[0]);
  assert(sum.sync_ms === 118 && sum.stages.router.ms === 115 && sum.stages.router.n === 2 && !("inner" in sum.stages) && sum.stages.respond === 2, lines[0]);
  assert(sum.budget_ms === EDGE_CPU_LIMIT_MS && sum.intent === "career_discovery", lines[0]);
});

Deno.test({ name: "c01: teardown", ...T, async fn() {
  console.log = rawLog;
  handler?.restore();
  await pg?.stop();
} });
