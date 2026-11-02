// JOIN-1215 (coordinator, 2026-10-25): the submission chain's seam assertions, rewritten as behavior of the production
// agent-chat handler. Each test sends the person's own texts through handleChat (supabase/functions/agent-chat/
// handler-career.ts), unchanged, on a real Postgres (CI's migration order) with the real supabase-js client; the only
// seam is the HTTP hop to the Supabase project (tests/flow/postgrest.ts answers it over the same database). What is
// asserted is what the person reads and what the database holds afterwards, never which function was called.
//
//   (a) resume: the entries the router shows -> the person's exact yes -> a provenance event per entry -> the facts the
//       executor reads (storedProfile -> trustedProfile) (a1). A confirmation the host cannot evidence (the event write
//       broken (a3), or a reply that showed no entry (a2), an explicit synthetic stand-in) is held as a draft and the
//       reply says so; it is never called confirmed.
//   (b) name, email, phone: their words reach a form only through a write that happened ("use N" on the question);
//       a statement alone writes nothing, and nothing is claimed for it.
//   (c) work authorization: the same, from their own statement; a write that fails is never called saved.
//   (d) status: "where are my applications" / "did my application to X go through" from career_apply_jobs; never
//       "submitted" as a success without the recorded confirmation; an unreadable record is said.
//
// What the router renders is Muse's (SPLIT-1146). (a1) and (a3) need the router's reply to show the entries (e0aad64b
// does). The sponsorship reply case is in tests/architect/pending/handler-submit-router.test.ts and stays red until the
// router's reply claims no packet that does not exist.
//
// Run: the gate runs it with CI=true (a missing Postgres or browser throws). Where esm.sh is unreachable, add
// --import-map=tests/flow/supabase-npm.json (the same supabase-js 2.117.1 from npm).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { storedProfile, trustedProfile } from "../../workers/career-browser/prepare-ahead.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PEOPLE: Record<string, string> = {};
for (let i = 1; i <= 11; i++) PEOPLE[`tok-${i}`] = `7b0f8f8e-6a43-4a49-9d2c-00000000f${String(i).padStart(3, "0")}`;
const SAVED_CLAIM = /\b(saved|recorded|on file|on your record|stored)\b/i;

let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
async function world() {
  if (handler) return { pg: pg!, handler };
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  handler = await careerHandler(pg, PEOPLE);
  return { pg, handler };
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the handler-level submission tests need Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const count = async (sql: string) => Number(await pg!.sql(sql));
const ok = (t: { status: number; reply: string }) => assert(t.status === 200, `the turn answered: ${t.status} ${t.reply}`);
// The executor's facts for a person: what the server prepare reads (their stored profile) and the trust contract keeps.
async function executorFacts(person: string) {
  const answers = JSON.parse(await pg!.sql(`select coalesce(json_agg(json_build_object('id', id, 'key', key, 'kind', kind, 'answer', answer)), '[]') from public.career_apply_questions where user_id = '${person}' and state = 'answered'`));
  const profile = await storedProfile(pg!.asService())(person);
  return trustedProfile(profile, person, answers)?.facts.length ?? 0;
}
// A question an application stopped on, as the server prepare stores it (career_apply_prepare_ask_for).
async function asked(person: string, questions: { key: string; label: string; type?: string; options?: string[] }[]) {
  const r = await pg!.asService().rpc("career_apply_prepare_ask_for", {
    p_user: person, p_posting_job_id: "greenhouse:handlertest:1", p_engine_job_id: "greenhouse:handlertest:1",
    p_questions: questions.map((q) => ({ kind: "fact", type: q.type ?? "input_text", options: q.options ?? [], company: "TEST Handler Employer", ...q })),
  });
  eq(r.error, null, JSON.stringify(r.error));
}
// "what do you need from me" shows one question at a time (review of #360); "skip" until the question with this label is
// the one shown, then "use 1" for its offer; the replies as the person reads them.
async function useOffer(chat: Chat, label: string) {
  let shown = await chat.say("what do you need from me");
  ok(shown);
  for (let i = 0; i < 12 && !shown!.reply.includes(label); i++) { shown = await chat.say("skip"); ok(shown); }
  assert(shown!.reply.includes(label), `${label} is asked: ${shown!.reply}`);
  const used = await chat.say("use 1");
  return { shown: shown!, used };
}
const answerOf = async (person: string, key: string) =>
  await pg!.sql(`select coalesce(answer, '') from public.career_apply_questions where user_id = '${person}' and key = '${key}'`);

// A reply that shows a count and no entry, written into the thread in place of the router's reply: an explicit synthetic
// stand-in, so this negative holds whatever the router renders.
const COUNT_ONLY = "Your resume is on record — as drafts, awaiting your word. I read it as 15 facts — every one is held as a DRAFT on your profile. " +
  "Say \"yes, that's my resume\" and I confirm them as your facts.";
const norm = (x: string) => String(x).replace(/\s+/g, " ").toLowerCase();
const draftsOf = async (person: string) =>
  JSON.parse(await pg!.sql(`select coalesce(state->'career'->'stores'->'profile'->'facts', '[]') from public.agent_flow_state where user_id = '${person}' order by updated_at desc limit 1`));

Deno.test({ name: "handler (a1): the router's reply shows each entry's words; the yes gives each a provenance event naming the upload; the executor gets exactly those", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-10"], chat = handler.chat("tok-10");
  const pasted = await chat.say(`here is my resume:\n${RESUME}`);
  ok(pasted);
  const facts = await draftsOf(person);
  assert(facts.length > 0, "the resume was read");
  const unshown = facts.filter((f: any) => !norm(pasted.reply).includes(norm(f.text)));
  eq(unshown.length, 0, `every entry's words are shown before the yes (${unshown.length} of ${facts.length} not shown): ${pasted.reply.slice(0, 300)}`);
  const yes = await chat.say("yes, that's my resume");
  ok(yes);
  eq(await count(`select count(*) from public.career_events where user_id = '${person}' and kind = 'fact_confirmed' and detail->'upload'->>'ref' like 'agent_messages:%'`), facts.length,
    `one provenance event per entry, naming the upload: ${yes.reply}`);
  eq(await executorFacts(person), facts.length, "the executor's facts are exactly those entries");
} });

Deno.test({ name: "handler (a3): entries shown, the event write broken: nothing is confirmed and the reply says so", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler, pg } = await world();
  const person = PEOPLE["tok-11"], chat = handler.chat("tok-11");
  const pasted = await chat.say(`here is my resume:\n${RESUME}`);
  ok(pasted);
  const facts = await draftsOf(person);
  assert(facts.length > 0 && facts.every((f: any) => norm(pasted.reply).includes(norm(f.text))), "precondition: the router showed every entry");
  await pg.sql(`revoke insert on public.career_events from service_role`);
  try {
    const yes = await chat.say("yes, that's my resume");
    ok(yes);
    assert(!/^Confirmed\b|now run on them/.test(yes.reply) && /could not be recorded/.test(yes.reply), yes.reply);
    eq(await executorFacts(person), 0);
    assert((await draftsOf(person)).every((f: any) => f.status === "draft"), "the drafts stay drafts");
  } finally {
    await pg.sql(`grant insert on public.career_events to service_role`);
  }
} });

Deno.test({ name: "handler (a2): a yes to a reply that showed a count and no entry is held as drafts and never called confirmed", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-1"], chat = handler.chat("tok-1");
  const pasted = await chat.say(`here is my resume:\n${RESUME}`);
  ok(pasted);
  eq(pasted.intent, "career_resume_ingest");
  await pg!.sql(`update public.agent_messages set content = $c$${COUNT_ONLY}$c$ where id = (select max(id) from public.agent_messages where thread_id = '${chat.thread()}' and role = 'assistant')`);
  const yes = await chat.say("yes, that's my resume");
  ok(yes);
  assert(!/^Confirmed\b|are confirmed, in your own words|now run on them/.test(yes.reply), `the reply claims nothing: ${yes.reply}`);
  assert(/stay drafts|Nothing from your resume is confirmed/.test(yes.reply) && /not shown to you word for word/.test(yes.reply), yes.reply);
  eq(await count(`select count(*) from public.career_events where user_id = '${person}' and kind = 'fact_confirmed'`), 0, "no provenance event without the entries shown");
  eq(await executorFacts(person), 0, "the executor gets none");
  const stored = JSON.parse(await pg!.sql(`select coalesce(state->'career'->'stores'->'profile'->'facts', '[]') from public.agent_flow_state where user_id = '${person}' order by updated_at desc limit 1`));
  assert(stored.length > 0 && stored.every((f: any) => f.status === "draft" && f.needs_confirmation === true), "the drafts stay drafts in the saved profile");
} });

Deno.test({ name: "handler (b1): a phone, name or email said in chat writes nothing and claims nothing; it reaches the form only through their own 'use N'", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-3"], chat = handler.chat("tok-3");
  for (const t of ["my phone number is 312-555-0142", "my name is Jordan Rivera", "my email is jordan.rivera@example.test"]) {
    const r = await chat.say(t);
    ok(r);
    assert(!SAVED_CLAIM.test(r.reply), `"${t}" claims no write: ${r.reply}`);
  }
  eq(await count(`select count(*) from public.career_apply_questions where user_id = '${person}'`), 0, "a statement alone writes nothing");
  await asked(person, [{ key: "fact:phone", label: "Phone" }, { key: "fact:first_name", label: "First name" }, { key: "fact:last_name", label: "Last name" }, { key: "fact:email", label: "Email" }]);
  const shown = await chat.say("what do you need from me");
  ok(shown);
  // One question at a time: the one shown offers their own words for it.
  assert(["my phone number is 312-555-0142", "my name is Jordan Rivera", "my email is jordan.rivera@example.test"].some((w) => shown!.reply.includes(`"${w}"`)),
    `their own words are offered back: ${shown!.reply}`);
  eq(await answerOf(person, "fact:phone"), "", "showing it saves nothing");
  const phone = await useOffer(chat, "Phone");
  assert(/Saved, as drafted/.test(phone.used.reply), phone.used.reply);
  eq(await answerOf(person, "fact:phone"), "312-555-0142", "their words, exactly");
  for (const [label, key, want] of [["First name", "fact:first_name", "Jordan"], ["Last name", "fact:last_name", "Rivera"], ["Email", "fact:email", "jordan.rivera@example.test"]]) {
    const r = await useOffer(chat, label);
    assert(/Saved, as drafted/.test(r.used.reply), r.used.reply);
    eq(await answerOf(person, key), want);
  }
} });

Deno.test({ name: "handler (b2): when the write fails, 'use N' is never called saved and nothing is stored", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler, pg } = await world();
  const person = PEOPLE["tok-4"], chat = handler.chat("tok-4");
  ok(await chat.say("my phone number is 312-555-0177"));
  await asked(person, [{ key: "fact:phone", label: "Phone" }]);
  await pg.sql(`revoke execute on function public.career_apply_question_answer_as(uuid, uuid, text) from service_role`);
  try {
    const r = await useOffer(chat, "Phone");
    assert(!/Saved/.test(r.used.reply), `a failed write is not called saved: ${r.used.reply}`);
    eq(await answerOf(person, "fact:phone"), "");
  } finally {
    await pg.sql(`grant execute on function public.career_apply_question_answer_as(uuid, uuid, text) to service_role`);
  }
} });

Deno.test({ name: "handler (c1): a work-authorization statement reaches the form only through their own 'use N', as they said it", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-5"], chat = handler.chat("tok-5");
  ok(await chat.say("I'm authorized to work in the US"));
  ok(await chat.say("I don't need visa sponsorship"));
  eq(await count(`select count(*) from public.career_apply_questions where user_id = '${person}'`), 0, "the statements alone write nothing");
  const AUTH = "Are you legally authorized to work in the United States?", SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
  await asked(person, [{ key: "fact:work_authorization", label: AUTH, type: "select", options: ["Yes", "No"] }, { key: "fact:sponsorship", label: SPONSOR, type: "select", options: ["Yes", "No"] }]);
  const wa = await useOffer(chat, AUTH);
  assert(wa.shown.reply.includes(`"I'm authorized to work in the US"`), wa.shown.reply);
  eq(await answerOf(person, "fact:work_authorization"), "Yes");
  const sp = await useOffer(chat, SPONSOR);
  assert(sp.shown.reply.includes(`"I don't need visa sponsorship"`), sp.shown.reply);
  eq(await answerOf(person, "fact:sponsorship"), "No");
} });

Deno.test({ name: "handler (c2): a citizenship statement answers neither question; nothing is offered or written from it", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-6"], chat = handler.chat("tok-6");
  ok(await chat.say("I'm a US citizen"));
  const AUTH = "Are you legally authorized to work in the United States?";
  await asked(person, [{ key: "fact:work_authorization", label: AUTH, type: "select", options: ["Yes", "No"] }]);
  const shown = await chat.say("what do you need from me");
  ok(shown);
  assert(!/You told me on/.test(shown.reply), `citizenship is not offered as work authorization: ${shown.reply}`);
  eq(await answerOf(person, "fact:work_authorization"), "");
} });

// (d): the queue's own rows, as the queue writes them (setup), then the person's questions through the handler.
async function jobs(person: string) {
  const row = (company: string, state: string, conf: string | null, reason: string | null, email: boolean) => {
    const payload = { version: "1", user_id: person, job_id: `gh:${company}`, company, url: `https://${company.toLowerCase()}.example.test/apply`, fields: [] };
    const hash = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
    return `('${person}', 'gh:${company}', '${company}', '${payload.url}', '${JSON.stringify(payload)}'::jsonb, '${hash}', '${hash}', '${state}', ${reason ? `'${reason}'` : "null"}, ${conf ? `'${conf}'` : "null"}, ${email ? `now(), '${"e".repeat(64)}'` : "null, null"})`;
  };
  await pg!.sql(`set session_replication_role = replica;
    insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, reason, confirmation_id, email_confirmed_at, confirmation_mail_hash) values
      ${row("Acme", "confirmed", "ACME-1", null, true)}, ${row("Globex", "submitted_unconfirmed", "CONF-4242", null, false)},
      ${row("Initech", "unknown_outcome", null, null, false)}, ${row("Umbrella", "queued", null, null, false)},
      ${row("Hooli", "not_submitted", null, "the employer page changed after you approved it", false)};
    set session_replication_role = origin;`);
}

Deno.test({ name: "handler (d1): 'where are my applications' is answered from career_apply_jobs, each in its recorded state", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-7"], chat = handler.chat("tok-7");
  const before = await chat.say("where are my applications");
  ok(before);
  assert(/No applications are on record/.test(before.reply), `none yet, said plainly: ${before.reply}`);
  await jobs(person);
  const all = await chat.say("where are my applications");
  ok(all);
  for (const [c, w] of [["Acme", /Acme confirmed it \(confirmation ACME-1\)/], ["Globex", /Globex has not confirmed it yet/], ["Initech", /can't tell whether it reached Initech/], ["Umbrella", /approved, not sent yet/], ["Hooli", /not sent \(the employer page changed/]] as const) {
    assert(w.test(all.reply), `${c}: ${all.reply}`);
  }
} });

Deno.test({ name: "handler (d2): 'did my application to X go through' never says submitted as a success without the recorded confirmation", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler } = await world();
  const person = PEOPLE["tok-8"], chat = handler.chat("tok-8");
  await jobs(person);
  const globex = await chat.say("did my application to Globex go through?");
  ok(globex);
  assert(/has not confirmed it yet/.test(globex.reply) && !/went through|Globex confirmed it|successful/i.test(globex.reply), globex.reply);
  const acme = await chat.say("did my application to Acme go through?");
  assert(/Acme confirmed it/.test(acme.reply), acme.reply);
  const stark = await chat.say("did my application to Stark Industries go through?");
  assert(/no application to Stark Industries on record/.test(stark.reply) && !/submitted/i.test(stark.reply.replace("no application", "")), stark.reply);
} });

Deno.test({ name: "handler (d3): when career_apply_jobs cannot be read, the reply says so and invents no empty record", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  const { handler, pg } = await world();
  const person = PEOPLE["tok-9"], chat = handler.chat("tok-9");
  await jobs(person);
  await pg.sql(`revoke select on public.career_apply_jobs from service_role`);
  try {
    const r = await chat.say("did my application to Acme go through?");
    ok(r);
    assert(/couldn't read your applications/.test(r.reply) && !/no application|confirmed it|not sent/i.test(r.reply), r.reply);
  } finally {
    await pg.sql(`grant select on public.career_apply_jobs to service_role`);
  }
} });

Deno.test({ name: "handler: teardown", sanitizeResources: false, sanitizeOps: false, async fn() {
  handler?.restore();
  if (pg) await pg.stop();
} });
