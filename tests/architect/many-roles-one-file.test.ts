// MANY ROLES, ONE FILE, ONE TAP (2026-11-06; supabase/functions/_shared/many_roles.ts). Through the production chat handler
// (agent-chat handler-career.ts handleChat) on a real Postgres with the real supabase-js client (tests/flow), and the File page
// (trainee-file) built from the same rows:
//   1. "find me 50 data analyst roles" gives a File of 50 (it gave 20 and said "I found 20" with 60 on the board); 80 asked is
//      held to the File's 50 and said; 30 asked with 12 on the board says those 12 are all.
//   2. "apply to 15 data analyst roles" (the router's batch ask) gives the File and starts preparing its 15 roles, never "0/0"
//      or "I haven't started that batch".
//   3. preparation goes only through the existing door (career_apply_wanted, then one kick for exactly the File's rows), and with
//      the prepare switch off the reply and the File say preparation is not running; nothing is queued for it.
//   4. "find ... and apply" searches, makes the File and starts preparing the listed roles; each still needs their tap.
//   Nothing in any of it approves or sends an application (career_apply_jobs stays empty). No model call, no network.
//
// Run: TMPDIR=/tmp/tpg PGBIN=/opt/homebrew/opt/postgresql@16/bin deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/many-roles-one-file.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { BATCH_NOT_STARTED_REPLY } from "../../supabase/functions/agent-chat/handler-career.ts";
import { askedCount, type FilePrep, prepareFileRows, prepLine, prepTop, RESULTS_FILE_MAX, wantsApply } from "../../supabase/functions/_shared/many_roles.ts";
import { cutNote } from "../../supabase/functions/_shared/role_results.ts";
import { applyManyAsk } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { signedIn } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const T = { sanitizeResources: false, sanitizeOps: false };

// ------------------------------------------------------------------------------------------------ the pure parts
Deno.test("many roles: the count asked for is read from the ask; pay, years and durations are never a count", () => {
  eq(askedCount("find me 50 data analyst roles"), 50);
  eq(askedCount("apply to 15 software engineering intern roles"), 15);
  eq(askedCount("show me the top 40 jobs in Chicago"), 40);
  eq(askedCount("find me 10 frontend internship roles"), 10);
  eq(askedCount("I want frontend internships that pay $30/hr"), null);
  eq(askedCount("summer 2027 internships in Chicago"), null);
  eq(askedCount("data roles paying 150k jobs"), null);
  eq(askedCount("roles that need 3 years experience"), null);
  eq(askedCount("find data analyst roles"), null);
  eq(RESULTS_FILE_MAX, 50);
});

Deno.test("many roles: '... and apply' is an apply ask; a question or a negated apply is not", () => {
  for (const m of ["find me 50 data analyst roles and apply", "find data analyst jobs in Chicago and apply to them", "apply to 15 data analyst roles", "find SWE intern roles then apply"]) assert(wantsApply(m), m);
  for (const m of ["find me 50 data analyst roles", "should I apply to data analyst roles?", "find data analyst roles but don't apply yet", "find roles, I'll apply myself later? "]) assert(!wantsApply(m), m);
});

Deno.test("many roles: when the File holds fewer than asked, the reply says how many and why; never when it holds them all", () => {
  eq(cutNote({ asked: 80, shown: 50, found: 50 }), "You asked for 80; one File holds at most 50, so it has the best 50 by fit.");
  eq(cutNote({ asked: 30, shown: 12, found: 12 }), "You asked for 30; those 12 are all I found.");
  eq(cutNote({ asked: 5, shown: 1, found: 1 }), "You asked for 5; that's the only one I found.");
  eq(cutNote({ asked: 50, shown: 50, found: 50 }), "");
  eq(cutNote({ asked: null, shown: 3, found: 3 }), "");
  eq(cutNote({ asked: null, shown: 25, found: 40 }), "That's the best 25 of the 40 I found; ask for up to 50 (\"find me 50 ...\") to see more.");
});

Deno.test("many roles: 'apply to these 20 roles' is the first 20 of the list (was: all of it); 'apply to these' is still all", () => {
  eq(applyManyAsk("apply to these 20 roles"), { kind: "first", n: 20 });
  eq(applyManyAsk("apply to those 12"), { kind: "first", n: 12 });
  eq(applyManyAsk("apply to these"), { kind: "all" });
  eq(applyManyAsk("apply to all of them"), { kind: "all" });
});

Deno.test("many roles: preparing the File's rows: off runs nothing and says so; a failure is said; a start says each still needs the tap", async () => {
  let ran = 0;
  const off = await prepareFileRows({ on: false, total: 15, now: 1, run: async () => { ran++; return null; } });
  eq([off.prep.state, off.prep.queued, ran], ["off", 0, 0]);
  assert(/Preparation isn't running right now/.test(prepLine(off.prep, null)) && /nothing was sent/.test(prepLine(off.prep, null)));
  assert(/Preparation isn't running right now/.test(prepTop(off.prep) ?? ""));
  const failed = await prepareFileRows({ on: true, total: 15, now: 1, run: () => Promise.reject(new Error("down")) });
  eq(failed.prep.state, "failed");
  assert(/nothing was prepared or sent/.test(prepLine(failed.prep, null)));
  const started = await prepareFileRows({ on: true, total: 15, now: 1, run: async () => ({ reply: "", status: "queued", intent: "career_apply_queue", coverage: { queued: 15, total: 15 }, prepare: "started", queued: [], refused: [] }) });
  eq([started.prep.state, started.prep.queued], ["started", 15]);
  const said = prepLine(started.prep, started.result);
  assert(/^I've started preparing all 15 /.test(said) && /nothing goes to an employer until you tap Apply on its card in the File/.test(said), said);
  eq(prepTop(started.prep), "Getting all 15 roles ready. A role shows Apply when it's ready; nothing is sent until you tap it.");
  const none: FilePrep = { state: "not_queued", queued: 0, total: 3, at: 1 };
  eq(prepLine(none, { reply: "", status: "no_resume", intent: "career_apply_queue" }, { resumeSaid: true }), "", "the resume line already says it");
  eq(prepTop(none), null);
});

// ------------------------------------------------------------------------------------------------ through the handler
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = {
  "mr-1": "7b0f8f8e-6a43-4a49-9d2c-0000000c1001", "mr-2": "7b0f8f8e-6a43-4a49-9d2c-0000000c1002", "mr-3": "7b0f8f8e-6a43-4a49-9d2c-0000000c1003",
  "mr-4": "7b0f8f8e-6a43-4a49-9d2c-0000000c1004", "mr-5": "7b0f8f8e-6a43-4a49-9d2c-0000000c1005", "mr-6": "7b0f8f8e-6a43-4a49-9d2c-0000000c1006",
};
const SECRET = "TEST-results-link-secret-0123456789abcdef", BASE = "https://trainee.example/file", DOOR = "http://prepare.test/run";
const NOW = Date.now(), HOUR = 3600000, iso = (ms: number) => new Date(ms).toISOString();
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
const kicks: { auth: string | null; body: { user_id: string; job_ids: string[] } }[] = [];
async function worldOnce() {
  if (handler) return;
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  // 60 data analyst roles in Chicago at 60 employers, and 12 payroll specialist roles.
  const rows: string[] = [];
  for (let i = 1; i <= 60; i++) rows.push(`('greenhouse:mrda${i}:1', 'greenhouse', 'mrda${i}', 'TEST Analytics ${i}', 'Data Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/mrda${i}/jobs/1', 'Analyze data with SQL and Python for our teams.', null, '${iso(NOW - i * HOUR)}', '${iso(NOW - i * HOUR)}', '${iso(NOW)}')`);
  for (let i = 1; i <= 12; i++) rows.push(`('greenhouse:mrpy${i}:1', 'greenhouse', 'mrpy${i}', 'TEST Payroll ${i}', 'Payroll Specialist', 'Chicago, IL', 'https://boards.greenhouse.io/mrpy${i}/jobs/1', 'Run payroll for our people.', null, '${iso(NOW - i * HOUR)}', '${iso(NOW - i * HOUR)}', '${iso(NOW)}')`);
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, pay, posted_at, first_seen_at, last_seen_at) values ${rows.join(",\n")}`);
  handler = await careerHandler(pg, PEOPLE);
  // The prepare door (CAREER_PREPARE_AHEAD_URL), answered here: every request the handler makes to it is kept.
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://prepare.test/")) {
      kicks.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
    }
    return inner(input as any, init);
  }) as typeof fetch;
}
const ENV_KEYS = ["TRAINEE_FILE_LINK_SECRET", "TRAINEE_FILE_BASE_URL", "CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "UPMORE_CAREER_WORKER_URL", "UPMORE_CAREER_WORKER_SECRET", "CLOUD_PREPARE_ENABLED"];
async function withEnv(set: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, ...set })) Deno.env.set(k, v);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
}
const PREPARE_ON = { CAREER_PREPARE_AHEAD_URL: DOOR, CAREER_PREPARE_AHEAD_TOKEN: "TEST-prepare-token" };
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the many-roles handler test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
async function withResume(token: string) {
  const chat = handler!.chat(token);
  eq((await chat.say(`here is my resume:\n${RESUME}`, { channel: "telegram" })).status, 200);
  eq((await chat.say("yes, that's my resume", { channel: "telegram" })).status, 200);
  return chat;
}
// The File the link opens, for this account (a signed-in session), as html and its plain text.
async function fileOf(person: string, link: string) {
  const claims = await verifyFileToken(new URL(link).searchParams.get("t")!, SECRET, Date.now());
  assert(claims.ok && claims.claims.u === person, "the link is this person's");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const A = signedIn();
  const d = { ...buildFileDeps(admin, { get: (k: string) => Deno.env.get(k) }, Date.now), ...A.deps };
  const s = await A.tok(person, claims.ok ? claims.claims.r : "", Date.now());
  const page = await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${s}` } }), d);
  eq(page.status, 200);
  const html = await page.text();
  return { html, text: plain(html), cards: (html.match(/<li class="card" id="r-/g) ?? []).length };
}
const count = async (table: string, person: string) => Number(await pg!.sql(`select count(*) from public.${table} where user_id = '${person}'`));
const linkPart = (parts: string[]) => { const l = parts.at(-1)!; assert(/^https:\/\/trainee\.example\/file\?t=v1\./.test(l), `the File's link is its own last message: ${l}`); return l; };

Deno.test({ name: "many roles (handler): 'find me 50 data analyst roles' -> a File of 50, the chat short and linking it; 80 is held to 50 and said; 30 with 12 on the board says so", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv({}, async () => {
    const person = PEOPLE["mr-1"], chat = await withResume("mr-1");
    const t = await chat.say("find me 50 data analyst roles", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[];
    eq(parts.length, 2, t.reply);
    assert(/^I found 50 data analyst roles\b/.test(parts[0]) && !/https?:/.test(parts[0]) && !/TEST Analytics/.test(parts[0]), parts[0]);
    assert(!/You asked for/.test(parts[0]), "nothing was cut, so nothing is said about a cut");
    const f = await fileOf(person, linkPart(parts));
    eq(f.cards, 50, "the File holds the 50 asked for (was 20)");
    assert(!/Showing the first/.test(f.text));
    eq(await count("career_apply_wanted", person), 0, "a search alone queues nothing");

    const big = await chat.say("find me 80 data analyst roles", { channel: "telegram" });
    const bp = big.body.parts as string[];
    assert(/You asked for 80; one File holds at most 50, so it has the best 50 by fit\./.test(bp[0]), bp[0]);
    eq((await fileOf(person, linkPart(bp))).cards, 50);

    const few = await chat.say("find me 30 payroll specialist roles", { channel: "telegram" });
    const fp = few.body.parts as string[];
    assert(/^I found 12 payroll specialist roles\b/.test(fp[0]) && /You asked for 30; those 12 are all I found\./.test(fp[0]), fp[0]);
    eq((await fileOf(person, linkPart(fp))).cards, 12);
    eq(await count("career_apply_jobs", person), 0, "nothing approved, nothing queued to send");
  });
} });

Deno.test({ name: "many roles (handler): 'apply to 15 data analyst roles' -> the File and preparation of its 15 roles through the one door; never the not-started batch or '0/0'", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(PREPARE_ON, async () => {
    const person = PEOPLE["mr-2"], chat = await withResume("mr-2");
    const before = kicks.length;
    const t = await chat.say("apply to 15 data analyst roles", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    assert(t.reply !== BATCH_NOT_STARTED_REPLY && !/haven't started that batch/.test(t.reply) && !/^0\/0/.test(t.reply), t.reply);
    const parts = t.body.parts as string[];
    assert(/^I found 15 data analyst roles\b/.test(parts[0]), parts[0]);
    assert(/I've started preparing all 15 from your confirmed facts/.test(parts[0]) && /nothing goes to an employer until you tap Apply on its card in the File/.test(parts[0]), parts[0]);
    const f = await fileOf(person, linkPart(parts));
    eq(f.cards, 15);
    assert(/Getting all 15 roles ready\. A role shows Apply when it's ready; nothing is sent until you tap it\./.test(f.text), "the File says they are being prepared");
    // The door: the File's 15 rows queued, and one kick for exactly those rows; nothing approved or sent.
    const queued = (await pg!.sql(`select posting_key from public.career_apply_wanted where user_id = '${person}' order by 1`)).split("\n").filter(Boolean);
    eq(queued.length, 15);
    eq(kicks.length - before, 1, "one kick for the batch");
    eq(kicks.at(-1)!.auth, "Bearer TEST-prepare-token");
    eq(kicks.at(-1)!.body.user_id, person);
    eq([...kicks.at(-1)!.body.job_ids].sort(), queued);
    eq(await count("career_apply_jobs", person), 0, "preparing approves and sends nothing");
  });
  // With the worker's batch delegation configured but no executor (where BATCH_NOT_STARTED_REPLY was the answer), the same.
  await withEnv({ ...PREPARE_ON, UPMORE_CAREER_WORKER_URL: "http://worker.test/batch", UPMORE_CAREER_WORKER_SECRET: "TEST-worker-secret" }, async () => {
    const person = PEOPLE["mr-3"], chat = await withResume("mr-3");
    const t = await chat.say("apply to 12 data analyst roles", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    assert(t.reply !== BATCH_NOT_STARTED_REPLY && !/haven't started that batch/.test(t.reply), t.reply);
    const parts = t.body.parts as string[];
    assert(/^I found 12 data analyst roles\b/.test(parts[0]) && /I've started preparing all 12/.test(parts[0]), parts[0]);
    eq((await fileOf(person, linkPart(parts))).cards, 12);
    eq(await count("career_apply_wanted", person), 12);
    eq(await count("career_apply_jobs", person), 0);
  });
} });

Deno.test({ name: "many roles (handler): 'find ... and apply' with preparation off -> the File, and the reply and the File say preparation is not running; nothing queued, nothing kicked", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv({}, async () => {
    const person = PEOPLE["mr-4"], chat = await withResume("mr-4");
    const before = kicks.length;
    const t = await chat.say("find me 20 data analyst roles in Chicago and apply", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[];
    assert(/^I found 20 data analyst roles in Chicago\b/.test(parts[0]), parts[0]);
    assert(/Preparation isn't running right now, so I haven't started on them and nothing was sent\./.test(parts[0]), parts[0]);
    assert(!/I've started preparing/.test(t.reply), "never says it is preparing");
    const f = await fileOf(person, linkPart(parts));
    eq(f.cards, 20);
    assert(/Preparation isn't running right now, so these roles aren't being prepared\./.test(f.text), "the File says so too");
    assert(!/Getting all/.test(f.text));
    eq(await count("career_apply_wanted", person), 0);
    eq(kicks.length, before);
    eq(await count("career_apply_jobs", person), 0);
  });
} });

Deno.test({ name: "many roles (handler): 'find ... and apply' with preparation on -> File and preparation of its rows; then 'apply to these 20 roles' over a File of 50 queues its first 20 and links the File; no resume queues nothing", ...T, async fn() {
  if (skip()) return;
  await worldOnce();
  await withEnv(PREPARE_ON, async () => {
    const person = PEOPLE["mr-5"], chat = await withResume("mr-5");
    const t = await chat.say("find data analyst jobs in Chicago and apply to them", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[];
    assert(/I've started preparing all \d+ from your confirmed facts/.test(parts[0]) && /until you tap Apply/.test(parts[0]), parts[0]);
    const f = await fileOf(person, linkPart(parts));
    eq(await count("career_apply_wanted", person), f.cards, "every role on the File, and only those, is queued to be prepared");
    eq(kicks.at(-1)!.body.user_id, person);
    eq(kicks.at(-1)!.body.job_ids.length, f.cards);
    eq(await count("career_apply_jobs", person), 0);

    // A File of 50, then "apply to these 20 roles": its first 20 (the File's own order), and the File's link as its own message.
    const big = await chat.say("find me 50 data analyst roles", { channel: "telegram" });
    eq(big.status, 200);
    const bigLink = linkPart(big.body.parts as string[]);
    const before = await count("career_apply_wanted", person);
    const these = await chat.say("apply to these 20 roles", { channel: "telegram" });
    eq(these.status, 200, these.reply);
    const tp = these.body.parts as string[];
    const sameFile = async (l: string) => { const c = await verifyFileToken(new URL(l).searchParams.get("t")!, SECRET, Date.now()); return c.ok ? c.claims.r : null; };
    eq(await sameFile(linkPart(tp)), await sameFile(bigLink), "the link is the File 'these' meant");
    assert(/\b20\/20 queued\b|already in your queue/.test(tp[0]), tp[0]);
    assert((await count("career_apply_wanted", person)) - before <= 20, "at most the 20 asked for were added");
    eq(await count("career_apply_jobs", person), 0);
  });
  // No confirmed resume: the File and the resume line; nothing queued, nothing kicked.
  await withEnv(PREPARE_ON, async () => {
    const person = PEOPLE["mr-6"], chat = handler!.chat("mr-6"), before = kicks.length;
    const t = await chat.say("find me 10 data analyst roles and apply", { channel: "telegram" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[];
    assert(parts.some((p) => /nothing is sent anywhere before your resume is confirmed/.test(p)), t.reply);
    assert(!/I've started preparing/.test(t.reply), t.reply);
    eq((await fileOf(person, linkPart(parts))).cards, 10);
    eq(await count("career_apply_wanted", person), 0);
    eq(kicks.length, before);
  });
} });
