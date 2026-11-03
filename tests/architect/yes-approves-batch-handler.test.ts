// Apply-all by yes (PR #430) through the REAL agent-chat handler (handleChat) on a real Postgres 16 with every migration: the results
// message ends with the one question and records the offer on that assistant row; a bare yes approves exactly the offered roles
// (career_apply_jobs), D-MS-1 words only; an employer question the yes asks can be answered by the next message; no confirmed resume,
// no offer; the off switch; a paused account. A throwaway cluster (as the postgres user when run as root).
// Run: bash tests/flow/run-real-flow.sh tests/architect/yes-approves-batch-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { payloadOf, RESUME_A } from "./scenarios-apply-r3-battery.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const NOW = Date.now(), DAY = 86400000, iso = (ms: number) => new Date(ms).toISOString();
const SECRET = "TEST-results-link-secret-0123456789abcdef", BASE = "https://trainee.example/file";
const P: Record<string, string> = {};
for (let i = 1; i <= 12; i++) P[`q-${i}`] = `7b0f8f8e-6a43-4a49-9d2c-0000000b${String(i).padStart(4, "0")}`;
const LIVE = [
  { id: "greenhouse:qa:1", company: "TEST Web", title: "Frontend Engineering Intern", loc: "Chicago, IL", d: "Build React and TypeScript components. Pay: $35 - $40 per hour." },
  { id: "greenhouse:qa:2", company: "TEST Design", title: "Frontend Intern", loc: "Remote", d: "Ship UI features in JavaScript with our design team." },
  { id: "greenhouse:qa:3", company: "TEST Quiet", title: "Frontend Developer Intern", loc: "Chicago, IL", d: "Build web pages in JavaScript and CSS for our product." },
  { id: "greenhouse:qa:4", company: "TEST Fourth", title: "Frontend Intern", loc: "Chicago, IL", d: "JavaScript and CSS frontend internship." },
];
const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };
const T = { sanitizeResources: false, sanitizeOps: false };
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
async function world() {
  if (handler) return;
  pg = await startPg(); await supabaseParity(pg);
  for (const id of Object.values(P)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  for (const [i, p] of LIVE.entries()) {
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
      values ('${p.id}', 'greenhouse', 'qa', '${p.company}', '${p.title}', '${p.loc}', 'https://boards.greenhouse.io/qa/jobs/${i + 1}', '${p.d}', '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW - (i + 1) * DAY)}', '${iso(NOW)}')`);
  }
  handler = await careerHandler(pg, P);
}
const sql = (q: string) => pg!.sql(q);
async function seedResume(u: string) {
  await sql(`${confirmedResumeSql(u, RESUME_A)}
    insert into public.career_resume_devices (user_id, sha256, at) values ('${u}', encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex'), now());`);
}
let ver = 0;
async function prepare(u: string, idx: number, note?: string) {
  const p = LIVE[idx], url = `https://boards.greenhouse.io/qa/jobs/${idx + 1}`;
  const sha = (await sql(`select encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex')`)).trim();
  // deno-lint-ignore no-explicit-any
  const payload: any = payloadOf({ spec: { company: p.company }, jobId: p.id, url } as any, { expiresIn: 3600_000, stamp: "current", fields: [], quarantine: "current" } as any, ++ver, { epoch: 0, version: 0, authority: 0 }, Date.now(), u, sha);
  if (note) payload.cover_note = { text: note };
  await sql(`update public.career_apply_prepared set state = 'expired' where user_id = '${u}' and job_id = ${lit(p.id)} and state in ('ready','shown');
    insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
    select '${u}', ${lit(p.id)}, ${lit(p.company)}, ${lit(url)}, x.p, public.career_apply_payload_hash(x.p), array[${lit(p.company)}]::text[], 'ready' from (select ${lit(JSON.stringify(payload))}::jsonb as p) x`);
}
const jobs = async (u: string) => Number(await sql(`select count(*) from public.career_apply_jobs where user_id = '${u}'`));
const wants = async (u: string) => Number(await sql(`select count(*) from public.career_apply_wanted where user_id = '${u}'`));
const lastMeta = async (thread: string) => JSON.parse(await sql(`select coalesce(meta, '{}'::jsonb) from public.agent_messages where thread_id = '${thread}' and role = 'assistant' order by id desc limit 1`));
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the apply-all handler test needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const ENVK = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, OPENAI_API_KEY: "test-key" };
async function withEnv(fn: () => Promise<void>, extra: Record<string, string> = {}) {
  const keys = [...Object.keys(ENVK), "CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN", "CAREER_APPLY_ALL_YES"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENVK)) Deno.env.set(k, v);
  for (const k of ["CAREER_JUDGE", "CAREER_REPLY_WRITER", "CAREER_BRAIN", "CAREER_APPLY_ALL_YES"]) Deno.env.delete(k);
  for (const [k, v] of Object.entries(extra)) Deno.env.set(k, v);
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
}
const ASK = "find me 10 frontend internship roles";

Deno.test({ name: "handler: the offer is stored on the results row; yes approves exactly the 3 prepared and queues the 4th to prepare; a second yes does nothing", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-1"]; await seedResume(u); for (const i of [0, 1, 2]) await prepare(u, i);
    const chat = handler!.chat("q-1");
    const t = await chat.say(ASK, { channel: "imessage" });
    eq(t.status, 200, t.reply);
    const parts = t.body.parts as string[];
    eq(parts.length, 3);
    assert(/^https:\/\/trainee\.example\/file\?t=v1\./.test(parts[1]), "the link is its own message");
    eq(parts[2], "Reply yes and I'll apply to the 3 prepared so far and get the other 1 ready. Each application's exact answers are on the page; I skip any with blank or sensitive answers.", "the results message ends with the one question");
    const m = await lastMeta(chat.thread()!);
    eq(m.apply_all_offer.jobs.length, 4); eq(m.apply_all_offer.jobs.filter((j: { tag: string | null }) => j.tag).length, 3);
    eq(await jobs(u), 0, "the results turn approved nothing");
    const y = await chat.say("yes", { channel: "imessage" });
    eq(y.intent, "career_apply_all_yes");
    eq(await jobs(u), 3, "exactly the 3 prepared were approved and queued");
    assert((await wants(u)) >= 1, "the unprepared one was queued to prepare");
    assert(/Approved and queued 3 applications/.test(y.reply) && !/\bapplied\b/i.test(y.reply.replace(/already in your applications/gi, "")), y.reply);
    const y2 = await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 3, "the second yes approves nothing new");
    assert(y2.intent !== "career_apply_all_yes", "the spent offer is not answered again");
  });
} });

Deno.test({ name: "handler: two yes at once do not double-queue", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-2"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-2");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    await Promise.all([chat.say("yes", { channel: "imessage" }), chat.say("Yes", { channel: "imessage" })]);
    eq(await jobs(u), 4, "four, never eight");
  });
} });

Deno.test({ name: "handler: a payload re-prepared after the offer is refused; ok, sure, sounds good, yes?, a thumbs-up and yes-with-more approve nothing", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-3"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-3");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    for (const m of ["ok", "okay", "sure", "sounds good", "absolutely", "definitely", "ya", "maybe", "yes?", "yeah maybe", "\u{1F44D}", "yes what is the salary?"]) {
      await chat.say(m, { channel: "imessage" });
      eq(await jobs(u), 0, `"${m}" approved something`);
      const mm = await lastMeta(chat.thread()!);
      if (!mm.apply_all_offer) { // a turn that is not the offer's spent it as the last word: ask again for a fresh one
        eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
      }
    }
    const c = await chat.say("yes but not TEST Web", { channel: "imessage" });
    eq(await jobs(u), 0, "a yes with a condition approves nothing");
    assert(/still open/.test(c.reply) && /reply just "yes"/.test(c.reply), c.reply);
    await prepare(u, 0, "A different cover note, added after the offer.");
    const y = await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 3, "the 3 unchanged were approved; the changed one was refused by name");
    assert(/TEST Web changed after I offered it/.test(y.reply), y.reply);
  });
} });

Deno.test({ name: "handler: no confirmed resume gets no offer and no queue", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-5"];
    const chat = handler!.chat("q-5");
    const t = await chat.say(ASK, { channel: "imessage" });
    assert(!/Reply yes and I'll/.test(t.reply), t.reply);
    assert(!(await lastMeta(chat.thread()!)).apply_all_offer, "no offer without a confirmed resume");
    await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 0); eq(await wants(u), 0, "nothing queued, not even to prepare");
  });
} });

Deno.test({ name: "handler: the employer question the yes asks is answered by the next message", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-9"]; await seedResume(u); await prepare(u, 1); // one role is ready, so the results message makes the offer
    await sql(`insert into public.career_apply_questions (user_id, key, kind, label, type, options, job_ids, company)
      values ('${u}', 'job:aaaaaaaaaaaaaaaa', 'attestation', 'Will you now or in the future require sponsorship?', 'select', '["Yes","No"]'::jsonb, array['greenhouse:qa:1'], 'TEST Web')`);
    const chat = handler!.chat("q-9");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    const y = await chat.say("yes", { channel: "imessage" });
    assert(/sponsorship/.test(JSON.stringify(y.body.parts ?? y.reply)), "the yes asked the open question");
    eq(y.intent, "career_apply_questions", "the question is the thread's last word as the questions flow expects");
    const a = await chat.say("No", { channel: "imessage" });
    assert(!/No to what\?/i.test(a.reply), a.reply);
    eq((await sql(`select count(*) from public.career_apply_questions where user_id = '${u}' and answer is not null`)).trim(), "1", "the answer landed on the question");
  });
} });

Deno.test({ name: "handler: a reply-quote yes (WhatsApp) reaches the batch; an intervening turn ends the offer; CAREER_APPLY_ALL_YES=off leaves no question and no offer; a paused account approves nothing", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-8"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-8");
    eq((await chat.say(ASK, { channel: "whatsapp" })).status, 200);
    const y = await chat.say("yes", { channel: "whatsapp", reply_to_message_id: "wamid.THE_RESULTS_MESSAGE" });
    eq(y.intent, "career_apply_all_yes", y.reply); eq(await jobs(u), 4);
  });
  await withEnv(async () => {
    const u = P["q-6"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-6");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    await chat.say("what is the pay on the first one?", { channel: "imessage" });
    await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 0, "an intervening turn ended the offer");
  });
  await withEnv(async () => {
    const u = P["q-10"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-10");
    const t = await chat.say(ASK, { channel: "imessage" });
    eq((t.body.parts as string[]).length, 2, "off: the results message is as it was");
    assert(!(await lastMeta(chat.thread()!)).apply_all_offer);
    await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 0);
  }, { CAREER_APPLY_ALL_YES: "off" });
  await withEnv(async () => {
    const u = P["q-7"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-7");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    await sql(`update public.career_watch_kv set value = '{"epoch":0,"version":0,"paused":true}' where user_id = '${u}' and key = 'career:account'`);
    await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 0, "a paused account approves nothing");
  });
} });

Deno.test({ name: "handler: a user turn stored after the offer with NO assistant reply ends the offer (offer must be the latest message by id)", ...T, async fn() {
  if (skip()) return; await world();
  await withEnv(async () => {
    const u = P["q-11"]; await seedResume(u); for (const i of [0, 1, 2, 3]) await prepare(u, i);
    const chat = handler!.chat("q-11");
    eq((await chat.say(ASK, { channel: "imessage" })).status, 200);
    assert((await lastMeta(chat.thread()!)).apply_all_offer, "the offer is on the newest assistant row");
    // A later user message that never got a reply (a failed or dropped turn): the newest ASSISTANT row is still the offer.
    await sql(`insert into public.agent_messages (thread_id, role, content) values ('${chat.thread()}', 'user', 'wait, not yet')`);
    await chat.say("yes", { channel: "imessage" });
    eq(await jobs(u), 0, "the offer is no longer the last word, so the yes approved nothing");
  });
} });
