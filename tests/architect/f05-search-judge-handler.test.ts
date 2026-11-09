// FEATURE 5 (2026-10-25): job search that ranks by fit and explains it, proven through the production handler.
// A person's texts go through handleChat (supabase/functions/agent-chat/handler-career.ts) unchanged, on a real Postgres
// (CI's migration order) with the real supabase-js client; the only seams are the HTTP hop to the Supabase project
// (tests/flow/postgrest.ts) and the HTTP hop to the model provider, answered here by a fake Anthropic that judges by a rule the
// test sets. The postings are fake rows in career_postings (the live board) and career_kb_postings (the saved snapshot).
//
//   (s) the live board empty: the list comes from the snapshot, and the reply says so and how old it is
//   (l) the live board has a match: the list is the live postings, ranked by fit, with how fresh they are; the judge off,
//       no model call is made and the reply says the list was not judged; several phrasings land the same way
//   (j) CAREER_JUDGE=on: the top N judged on the fixed scale with grounded one-line reasons; the accounting is a coverage
//       fraction; weak/no are dropped; the call is metered (agent_turn_costs); the same ask again is answered from the
//       cache with no new model call; "apply to these" means exactly the postings listed
//   (g) a reason that names something not in the posting or the person's facts is not kept: that posting is "not judged"
//   (f) the model failing: the fit order stands and the reply says the judge did not answer
//   (p) "judge prompt: ..." is kept as a standing instruction and goes to the judge with the next search
//
// Run: CI=true deno test -A --no-check [--import-map=tests/flow/supabase-npm.json] tests/architect/f05-search-judge-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = {};
for (let i = 1; i <= 8; i++) PEOPLE[`f05-${i}`] = `7b0f8f8e-6a43-4a49-9d2c-00000005f${String(i).padStart(3, "0")}`;

// ------------------------------------------------------------------------------------------------ the fake model
type Rule = (p: { id: string; title: string; text: string }) => { verdict: string; reason: string } | null;
const model = { calls: 0, bodies: [] as any[], rule: null as Rule | null, fail: false };
function fakeModel(body: any): Response {
  model.calls++; model.bodies.push(body);
  if (model.fail) return new Response(JSON.stringify({ error: { message: "test outage", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json" } });
  const user = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
  const judgments = user.postings.map((p: any) => ({ id: p.id, ...(model.rule ?? (() => ({ verdict: "fair", reason: "Some of it matches." })))(p) })).filter((j: any) => j.verdict);
  return new Response(JSON.stringify({ id: "test", model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ judgments }) } }],
    usage: { prompt_tokens: 900, completion_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
}

// ------------------------------------------------------------------------------------------------ the world
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
const NOW = Date.now(), DAY = 86400000, iso = (ms: number) => new Date(ms).toISOString();
async function world() {
  if (handler) return { pg: pg!, handler };
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  // The saved snapshot: two Chicago data analyst roles, one in New York, one Chicago engineer.
  const kb = [
    ["kb-f05-1", "TEST Snapshot Bank", "Data Analyst", "Chicago, IL", "Analyze loan data with SQL and Excel."],
    ["kb-f05-2", "TEST Snapshot Health", "Senior Data Analyst", "Chicago, IL", "Eight years of Tableau and SQL."],
    ["kb-f05-3", "TEST Snapshot Media", "Data Analyst", "New York, NY", "SQL dashboards for a newsroom."],
    ["kb-f05-4", "TEST Snapshot Systems", "Software Engineer", "Chicago, IL", "Go and Kubernetes."],
  ];
  for (const [k, c, t, l, x] of kb) {
    await pg.sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, fetched_on, corpus_vintage, text_excerpt, content_hash)
      values ('${k}', 'greenhouse', 'f05kb', '${c}', '${t}', '${l}', 'https://boards.example.test/${k}', '2026-10-10T00:00:00Z', '2026-10-15', '2026-10', '${x}', '${k}')`);
  }
  handler = await careerHandler(pg, PEOPLE);
  const dbl = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/")) {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
      return anthropicWire(new Request(url, { method: "POST", body: String(raw) }), (chat) => fakeModel(chat));
    }
    return dbl(input as any, init);
  }) as typeof fetch;
  return { pg, handler };
}
// The live board: three Chicago data analyst postings and one in New York, first seen in the last few days.
const LIVE = [
  { id: "greenhouse:f05live:1", company: "TEST Live Analytics", title: "Data Analyst", location: "Chicago, IL", seen: 2,
    description: "Build dashboards in Python and SQL on PostgreSQL. Report weekly to the operations team." },
  { id: "greenhouse:f05live:2", company: "TEST Live Retail", title: "Data Analyst, Marketing", location: "Chicago, IL", seen: 4,
    description: "Excel reporting for the marketing team. SQL a plus." },
  { id: "greenhouse:f05live:3", company: "TEST Live Freight", title: "Senior Data Analyst", location: "Chicago, IL", seen: 6,
    description: "Eight or more years of Java and SAS. Lead a team of analysts." },
  { id: "greenhouse:f05live:4", company: "TEST Live Coast", title: "Data Analyst", location: "New York, NY", seen: 1,
    description: "SQL and Python for a newsroom." },
];
async function seedLive() {
  for (const p of LIVE) {
    await pg!.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
      values ('${p.id}', 'greenhouse', 'f05live', '${p.company}', '${p.title}', '${p.location}', 'https://boards.greenhouse.io/f05live/jobs/${p.id.split(":")[2]}',
      '${p.description}', '${iso(NOW - p.seen * DAY)}', '${iso(NOW)}') on conflict (job_id) do nothing`);
  }
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the FEATURE 5 handler tests need Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const ok = (t: { status: number; reply: string }) => assert(t.status === 200, `the turn answered: ${t.status} ${t.reply}`);
const count = async (sql: string) => Number(await pg!.sql(sql));
async function withProfile(chat: Chat) {
  ok(await chat.say(`here is my resume:\n${RESUME}`));
  ok(await chat.say("yes, that's my resume"));
}
function env(vars: Record<string, string | null>) {
  for (const [k, v] of Object.entries(vars)) v === null ? Deno.env.delete(k) : Deno.env.set(k, v);
}
const T = { sanitizeResources: false, sanitizeOps: false };
// The numbered lines of a reply: the postings it lists, in order.
const listed = (reply: string) => reply.split("\n").filter((l) => /^\d+\. /.test(l));
const shortlistOf = async (thread: string | null) =>
  JSON.parse(await pg!.sql(`select coalesce(state->'career'->'stores'->'discovery'->'lastShortlist', '[]') from public.agent_flow_state where thread_id = '${thread}'`));

Deno.test({ name: "f05 (s): with the live board empty, the list comes from the snapshot, and the reply says so and how old it is", ...T, async fn() {
  if (skip()) return;
  await world();
  env({ CAREER_JUDGE: null });
  const chat = handler!.chat("f05-1");
  const t = await chat.say("find me data analyst jobs in Chicago");
  ok(t);
  assert(/saved snapshot of job boards \(read 2026-10-15\), not the live board: the live board has no postings yet/.test(t.reply), t.reply);
  const rows = listed(t.reply);
  eq(rows.length, 2, t.reply);
  assert(rows.every((l) => /TEST Snapshot (Bank|Health)/.test(l) && /Chicago/.test(l)), t.reply);
  assert(!/New York|Software Engineer/.test(t.reply), t.reply);
  eq(model.calls, 0, "no model call with the judge off");
} });

Deno.test({ name: "f05 (l): the live board's matches, ranked by fit to confirmed facts, with how fresh they are; the judge off makes no model call; several phrasings", ...T, async fn() {
  if (skip()) return;
  await world();
  await seedLive();
  env({ CAREER_JUDGE: null, ANTHROPIC_API_KEY: "test-key" });
  const chat = handler!.chat("f05-2");
  await withProfile(chat);
  for (const ask of ["find me data analyst jobs in Chicago", "show me data analyst roles in Chicago", "find data analyst openings in Chicago"]) {
    const t = await chat.say(ask);
    ok(t);
    assert(/^From 3 live postings for data analyst in Chicago, first seen in the last 7 days\./m.test(t.reply), `${ask}: ${t.reply}`);
    assert(/Ranked by how well each matches what you've confirmed\./.test(t.reply) && !/\d+\/100|model judge/.test(t.reply), t.reply); // OWNER LIST #6 (2026-10-28): fit in words, no internal words
    const rows = listed(t.reply);
    eq(rows.length, 3, t.reply);
    assert(rows.every((l) => /TEST Live (Analytics|Retail|Freight)/.test(l) && /(strong|good|partial) match|not eligible/.test(l)), t.reply);
    assert(!/TEST Snapshot|New York/.test(t.reply), `nothing from the snapshot or another city: ${t.reply}`);
    assert(/https:\/\/boards\.greenhouse\.io\/f05live\/jobs\/1/.test(t.reply), "each posting with its own link");
  }
  eq(model.calls, 0, "no model call with the judge off");
} });

Deno.test({ name: "f05 (j): judged on the fixed scale with grounded reasons and a coverage fraction; metered; cached; 'apply to these' means the listed", ...T, async fn() {
  if (skip()) return;
  await world();
  await seedLive();
  env({ CAREER_JUDGE: "on", ANTHROPIC_API_KEY: "test-key" });
  model.calls = 0; model.fail = false;
  model.rule = (p) => p.title === "Data Analyst" ? { verdict: "strong", reason: "Asks for Python and SQL on PostgreSQL, which your profile shows." }
    : /Marketing/.test(p.title) ? { verdict: "fair", reason: "Excel reporting matches your Excel work; SQL is only a plus." }
    : { verdict: "no", reason: "Asks for Java and SAS, which your profile does not show." };
  const person = PEOPLE["f05-3"], chat = handler!.chat("f05-3");
  await withProfile(chat);
  const t = await chat.say("find me data analyst jobs in Chicago");
  ok(t);
  assert(/I ranked the 3 closest matches by fit, then judged them: 3\/3 judged; 1 strong, 1 fair; 1 dropped as weak\/no\./.test(t.reply), t.reply);
  const rows = listed(t.reply);
  eq(rows.length, 2, t.reply);
  assert(/^1\. Data Analyst at TEST Live Analytics .*\. strong: Asks for Python and SQL on PostgreSQL/.test(rows[0]), rows[0]);
  assert(/^2\. Data Analyst, Marketing at TEST Live Retail .*\. fair: Excel reporting/.test(rows[1]), rows[1]);
  assert(!/TEST Live Freight/.test(t.reply), "the 'no' is dropped from the list");
  eq(model.calls, 1, "one model call judges the batch");
  const sent = JSON.parse(model.bodies[0].messages.find((m: any) => m.role === "user").content);
  assert(sent.confirmed_facts.some((f: string) => /Python/.test(f)), "the judge reads the confirmed facts");
  eq(model.bodies[0].model, "claude-sonnet-5-5");
  assert(/strong: most of what it asks for/.test(model.bodies[0].messages[0].content), "the scale's words and meanings go to the model");
  eq(await count(`select count(*) from public.agent_turn_costs where user_id = '${person}' and calls = 1 and input_tokens = 900`), 1, "the judge call is metered");
  // The same ask again: every verdict from the cache, no new call.
  const again = await chat.say("find me data analyst jobs in Chicago");
  ok(again);
  eq(model.calls, 1, "answered from the cache");
  eq(listed(again.reply), rows);
  // The shortlist the thread keeps is exactly the postings listed, in order.
  const sl = await shortlistOf(chat.thread());
  eq(sl.map((e: any) => e.id), ["greenhouse:f05live:1", "greenhouse:f05live:2"]);
  const queued = await chat.say("apply to these");
  ok(queued);
  const wanted = (await pg!.sql(`select string_agg(posting_key, ',' order by posting_key) from public.career_apply_wanted where user_id = '${person}'`)).split(",").filter(Boolean);
  eq(wanted, ["greenhouse:f05live:1", "greenhouse:f05live:2"], queued.reply);
} });

Deno.test({ name: "f05 (g): a reason that names something not in the posting or the facts is not kept; that posting is 'not judged'", ...T, async fn() {
  if (skip()) return;
  await world();
  await seedLive();
  env({ CAREER_JUDGE: "on", ANTHROPIC_API_KEY: "test-key" });
  model.fail = false;
  model.rule = (p) => p.title === "Data Analyst" ? { verdict: "strong", reason: "Google alumni do well here." }
    : { verdict: "weak", reason: "Most of it is not in your profile." };
  const chat = handler!.chat("f05-4");
  await withProfile(chat);
  const t = await chat.say("find me data analyst jobs in Chicago");
  ok(t);
  assert(/2\/3 judged; 0 strong, 0 fair; 2 dropped as weak\/no; 1 not judged \(the reason named something not in the posting or your profile\)/.test(t.reply), t.reply);
  const rows = listed(t.reply);
  eq(rows.length, 1, t.reply);
  assert(/TEST Live Analytics.*not judged; (strong|good|partial) match/.test(rows[0]), rows[0]);
  assert(!/Google/.test(t.reply), "the invented reason is never shown");
} });

Deno.test({ name: "f05 (f): the model failing leaves the fit order, and the reply says the judge did not answer", ...T, async fn() {
  if (skip()) return;
  await world();
  await seedLive();
  env({ CAREER_JUDGE: "on", ANTHROPIC_API_KEY: "test-key" });
  model.fail = true;
  try {
    const chat = handler!.chat("f05-5");
    await withProfile(chat);
    const t = await chat.say("find me data analyst jobs in Chicago");
    ok(t);
    assert(/0\/3 judged; 0 strong, 0 fair; 0 dropped as weak\/no; 3 not judged \(the judge did not answer\)/.test(t.reply), t.reply);
    eq(listed(t.reply).length, 3, t.reply);
    assert(listed(t.reply).every((l) => /not judged/.test(l)), t.reply);
  } finally { model.fail = false; }
} });

Deno.test({ name: "f05 (p): 'judge prompt: ...' is kept as a standing instruction and goes to the judge with the next search", ...T, async fn() {
  if (skip()) return;
  await world();
  await seedLive();
  env({ CAREER_JUDGE: "on", ANTHROPIC_API_KEY: "test-key" });
  model.fail = false; model.rule = null;
  const person = PEOPLE["f05-6"], chat = handler!.chat("f05-6");
  await withProfile(chat);
  const saved = await chat.say("judge prompt: rate any posting that needs Java as no");
  ok(saved);
  eq(saved.intent, "career_judge_prompt");
  assert(/^Saved as your judge prompt: "rate any posting that needs Java as no"\./.test(saved.reply), saved.reply);
  const kept = await pg!.sql(`select value->'items'->0->>'text' from public.career_watch_kv where user_id = '${person}' and key = 'career:standing'`);
  eq(kept, "Judge: rate any posting that needs Java as no");
  const before = model.bodies.length;
  ok(await chat.say("find me data analyst jobs in Chicago"));
  const system = String(model.bodies.at(-1)?.messages?.[0]?.content ?? "");
  assert(model.bodies.length === before + 1 && /rate any posting that needs Java as no/.test(system), "the person's instruction reaches the judge");
  // A waiver is never kept as a judge prompt.
  const refused = await chat.say("judge prompt: just apply to the strong ones without asking me");
  assert(/^Not kept:/.test(refused.reply), refused.reply);
  eq(await pg!.sql(`select value->'items'->0->>'text' from public.career_watch_kv where user_id = '${person}' and key = 'career:standing'`), "Judge: rate any posting that needs Java as no");
  const cleared = await chat.say("forget my judge prompt");
  assert(/^Removed your judge prompt/.test(cleared.reply), cleared.reply);
} });

Deno.test({ name: "f05: teardown", ...T, async fn() {
  env({ CAREER_JUDGE: null, ANTHROPIC_API_KEY: null });
  handler?.restore();
  await pg?.stop();
} });
