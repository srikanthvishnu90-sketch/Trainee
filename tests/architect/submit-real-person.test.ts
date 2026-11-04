// SUBMIT-STEER-1130 (coordinator, 2026-10-25): application submission on ONE path, for a person as the chat really leaves
// them, not a hand-made profile. The path: chat -> prepare (prepare-ahead.ts) -> card -> their own tap -> claim -> the
// engine submits on their computer (approve-first.ts runApproved) -> recorded outcome -> read back in chat.
//
// Measured at arch/backend-g6-receipts 6bf3478e with the product's chat host (the router bundle agent-chat runs):
//  1. "yes, that's my resume" confirms every resume fact with no provenance and no confirmation event, so the trust
//     contract (trustedProfile, trustedManifest) keeps none of them: 0 of 15. The server prepare then stops at no_resume
//     for every router-path person, before it asks anything.
//  2. With confirmed facts but no name and email on file, the resume cannot be tailored, and nothing asks for them:
//     no_resume, again, forever.
//  3. "my name is ...", "my email is ...", "my phone number is ..." said in chat never reach a form: only sponsorship and
//     work authorization are offered back from the person's own words (G2).
//  4. "did my application to Acme go through?" gets the banner, and "where are my applications" reads only the
//     router's own tracker: what the queue recorded (career_apply_jobs) is never read back.
// SPLIT-1146: this side owns the writers and the read-back (career_* modules, the handler's calls to them); the router's
// chat families are Muse's. The router's own replies (the resume confirm shows a count, not the entries; the sponsorship
// correction's "saved" with no profile) are Muse's to change; the writer below evidences only entries actually shown.
// Each test below fails at 6bf3478e on its first required assertion (or does not load: the modules it names are new).
// flow-real-person.test.ts drives the same person end to end on a real Postgres and a real browser.
import { createRequire } from "node:module";
import { evidenceResumeConfirmation, RESUME_CONFIRM_PROVENANCE, resumeConfirmationContext, sha256Hex } from "../../supabase/functions/_shared/career_router_evidence.ts";
import { prepareAhead, trustedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { type OpenQuestion, type QuestionStore, QUESTIONS_INTENT, questionsTurn, supabaseQuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { contactDraft } from "../../supabase/functions/_shared/contact_draft.ts";
import { type AppRow, applicationsTurn, STATUS_INTENT, statusReply } from "../../supabase/functions/_shared/career_apply_status.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";

const require = createRequire(import.meta.url);
const { CareerHost } = require("../../supabase/functions/_shared/career_host.js");
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000c1";
const T0 = Date.parse("2026-10-25T15:00:00Z");

// ---------------------------------------------------------------------------------------------- the chat, as it runs
const c: any = core;
const host = CareerHost.createCareerHost({
  CareerAccess: c.CareerAccess, CareerOnboarding: c.CareerOnboarding, CareerRouter: c.CareerRouter,
  CareerDoorstep: c.CareerDoorstep, CareerReply: c.CareerReply, CareerContainment: c.CareerContainment,
});
// A conversation through the host, the way agent-chat runs one (a ctx per turn from the last saved snapshot).
function conversation(user = PERSON) {
  let snap: any = null, now = T0;
  return {
    turn(message: string) {
      const before = snap ? structuredClone(snap.stores.profile ?? null) : null;
      const ctx = host.createTurnCtx({ userId: user, threadId: `thread-${user}`, now: (now += 60_000), snapshot: snap, postings: [] });
      const out = host.runTurn(message, ctx);
      return {
        out, ctx, before, now,
        save() { snap = host.extractSnapshot(ctx); },
      };
    },
    profile: () => (snap ? snap.stores.profile ?? null : null),
  };
}
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
function memoryEvents(fail = false) {
  const rows: any[] = [];
  return { rows, add: async (e: unknown) => { if (fail) throw new Error("TEST: the event store is down"); rows.push(e); }, recall: async () => [] };
}
const PASTED = `here is my resume:\n${RESUME}`;
// A reply that shows a count and no entry (the router's reply until e0aad64b), written out here so the negative stays a
// negative whatever the router renders: a yes to it confirms no entry's words.
const COUNT_ONLY = "Your resume is on record — as drafts, awaiting your word. I read it as 15 facts (1 education, 2 experience, 2 project, " +
  "1 leadership, 9 skill) — every one is held as a DRAFT on your profile. Say \"yes, that's my resume\" and I confirm them as your facts.";
// The person pastes their resume and says it is theirs; the handler's evidence step runs after the router's turn, with
// what the thread shows: their upload, and what Trainee showed them since. By default that is the router's own reply to
// the paste, as the router rendered it; `shown` replaces it with an explicit synthetic reply (the negatives).
async function resumeConfirmed(o: { events?: ReturnType<typeof memoryEvents>; shown?: string; upload?: string | null } = {}) {
  const events = o.events ?? memoryEvents();
  const chat = conversation();
  const pasted = chat.turn(PASTED);
  pasted.save();
  const shownText = o.shown ?? String(pasted.out.reply);
  const yes = chat.turn("yes, that's my resume");
  // The thread as agent-chat reads it, newest first: Trainee's reply, then the person's upload.
  const rows = [{ id: "2", role: "assistant", content: shownText }, ...(o.upload === null ? [] : [{ id: "1", role: "user", content: o.upload ?? PASTED }])];
  const seen = await resumeConfirmationContext(rows, yes.ctx.profile);
  const r = await evidenceResumeConfirmation({
    userId: PERSON, now: yes.now, message: "yes, that's my resume", before: yes.before, after: yes.ctx.profile, out: yes.out, events, ...seen,
  });
  yes.save();
  return { chat, pasted, yes, r, events, seen, profile: chat.profile() };
}

Deno.test("1. the router's own reply shows the entries; the person's yes evidences each, with its event and its upload link", async () => {
  const { pasted, yes, r, events, profile, seen } = await resumeConfirmed();
  // The router's reply itself (no listing added here): every entry's words, before the yes.
  const unshown = profile.facts.filter((f: any) => !String(pasted.out.reply).replace(/\s+/g, " ").toLowerCase().includes(String(f.text).replace(/\s+/g, " ").toLowerCase()));
  eq(unshown.length, 0, `the router's reply shows every entry: ${String(pasted.out.reply).slice(0, 300)}`);
  eq(seen.upload?.ref, "agent_messages:1", "the link to their own upload");
  eq(seen.upload?.sha256, await sha256Hex(PASTED));
  eq([yes.out.intent, yes.out.resultStatus], ["career_resume_ingest", "completed"], "the router's own confirm of the pasted resume");
  const n = profile.facts.length;
  assert(n >= 10, `the fixture resume is read as many facts (${n})`);
  eq(r.stamped, n, "each confirmed fact is stamped");
  eq(events.rows.length, n, "one fact_confirmed event per fact");
  for (const e of events.rows) {
    eq(e.kind, "fact_confirmed");
    assert(/^[0-9a-f]{64}$/.test(e.detail.message_sha256), "the event names the person's own message by its hash");
  }
  for (const f of profile.facts) {
    assert(f.confirmation_event_id && events.rows.some((e) => e.detail.confirmation_event_id === f.confirmation_event_id), `fact ${f.id} names its event`);
    assert(f.provenance.startsWith(RESUME_CONFIRM_PROVENANCE), f.provenance);
    eq(f.source_ref.upload, "agent_messages:1");
  }
  for (const e of events.rows) eq(e.detail.upload.ref, "agent_messages:1", "the event names the upload");
  const kept = trustedProfile({ ...profile, user_id: PERSON }, PERSON, []);
  eq(kept?.facts.length, n, "the trust contract keeps every one (at 6bf3478e: 0)");
});

Deno.test("1a. a yes to a reply that shows a count and no entry evidences nothing: no entry's words were shown", async () => {
  const { r, profile } = await resumeConfirmed({ shown: COUNT_ONLY });
  eq(r.stamped, 0);
  eq(r.unshown, profile.facts.length, "every entry: not shown");
  eq(r.held.length, profile.facts.length, "every entry is held as a draft");
  assert(profile.facts.every((f: any) => f.status === "draft" && f.needs_confirmation === true), "drafts stay drafts");
  eq(trustedProfile({ ...profile, user_id: PERSON }, PERSON, [])?.facts.length, 0, "the executor keeps none");
});

Deno.test("1a1. a reply that shows only some entries evidences only those; the rest stay drafts", async () => {
  const probe = await resumeConfirmed({ shown: COUNT_ONLY });
  const some = probe.profile.facts.slice(0, 3).map((f: any) => f.text).join("\n");
  const { r, profile } = await resumeConfirmed({ shown: `${COUNT_ONLY}\n${some}` });
  eq(r.stamped, 3, JSON.stringify(r));
  eq(r.unshown, profile.facts.length - 3);
  eq(trustedProfile({ ...profile, user_id: PERSON }, PERSON, [])?.facts.length, 3);
});

Deno.test("1a2. an entry not in the person's own upload is never evidenced, even when shown", async () => {
  const other = RESUME.replace(/TEST Systems Inc/g, "Another Co");
  const { r } = await resumeConfirmed({ upload: `here is my resume:\n${other}` });
  assert(r.untraced > 0 && r.stamped > 0, JSON.stringify(r));
  const none = await resumeConfirmed({ upload: null });
  eq(none.r.stamped, 0, "no upload in the thread: nothing evidenced");
});

Deno.test("1b. an event that cannot be recorded stamps nothing: the facts stay unevidenced and the executor keeps none", async () => {
  const { r, profile } = await resumeConfirmed({ events: memoryEvents(true) });
  eq(r.stamped, 0);
  assert(profile.facts.every((f: any) => !f.confirmation_event_id && !f.provenance), "nothing stamped without its event");
  eq(trustedProfile({ ...profile, user_id: PERSON }, PERSON, [])?.facts.length, 0);
});

Deno.test("1c. only the router's confirm of a pasted resume, and only entries that were drafts before this turn, are stamped", async () => {
  const { yes } = await resumeConfirmed();
  const shown = { text: String((await resumeConfirmed()).pasted.out.reply), message_ids: ["2"] }, upload = { kind: "message" as const, ref: "agent_messages:1", sha256: "x", text: PASTED };
  const fresh = conversation();
  const p1 = fresh.turn(PASTED);
  eq((await evidenceResumeConfirmation({ userId: PERSON, now: p1.now, message: PASTED, before: p1.before, after: p1.ctx.profile, out: p1.out, shown, upload, events: memoryEvents() })).stamped, 0,
    "pasting reads drafts; nothing confirmed, nothing stamped");
  p1.save();
  const y = fresh.turn("yes, that's my resume");
  eq((await evidenceResumeConfirmation({ userId: PERSON, now: y.now, message: "yes", before: y.before, after: structuredClone(y.ctx.profile), out: { intent: "tracking_status", resultStatus: "completed" }, shown, upload, events: memoryEvents() })).stamped, 0,
    "another intent's turn never stamps");
  eq((await evidenceResumeConfirmation({ userId: PERSON, now: y.now, message: "yes", before: null, after: structuredClone(y.ctx.profile), out: y.out, shown, upload, events: memoryEvents() })).stamped, 0,
    "no draft on record before the turn: nothing stamped");
  assert((await evidenceResumeConfirmation({ userId: PERSON, now: y.now, message: "yes", before: y.before, after: y.ctx.profile, out: y.out, shown, upload, events: memoryEvents() })).stamped > 0);
  y.save();
  const again = fresh.turn("yes, that's my resume");
  eq((await evidenceResumeConfirmation({ userId: PERSON, now: again.now, message: "yes", before: again.before, after: again.ctx.profile, out: again.out, shown, upload, events: memoryEvents() })).stamped, 0,
    "an entry confirmed and evidenced before the turn is never stamped again");
});

Deno.test("1d. agent-chat runs the evidence step on the router's turn, before the turn is saved", async () => {
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  const turn = src.lastIndexOf("host.runTurn(message, ctx)"), at = src.lastIndexOf("evidenceResumeConfirmation(");
  assert(turn > 0 && at > turn, "the handler calls it after the router's turn");
  assert(at < src.indexOf("persistence.commit("), "before the commit, so the stamps are saved with the turn");
  const ctxAt = src.indexOf("resumeConfirmationContext(", turn);
  assert(ctxAt > turn && ctxAt < at, "from the thread: what was shown and the upload");
});

// ---------------------------------------------------------------------------------------------- the server prepare
function fakeDb(o: { answers?: any[] } = {}) {
  const calls: { name: string; args: any }[] = [];
  const db = {
    calls,
    rpc: async (name: string, args?: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_candidates") {
        return { data: [{ user_id: PERSON, job_id: "greenhouse:submittest:1", company: "TEST Submit Employer", title: "TEST Analyst",
          url: "https://boards.greenhouse.io/submittest/jobs/1", location: "Chicago, IL", description: "TEST Analyst. SQL, Python.", epoch: 0, version: 0 }], error: null };
      }
      if (name === "career_apply_answers_for") return { data: o.answers ?? [], error: null };
      if (name === "career_apply_prepare_ask_for") return { data: (args.p_questions ?? []).length, error: null };
      return { data: null, error: null };
    },
  };
  return db;
}
const answered = (key: string, answer: string) => ({ id: crypto.randomUUID(), key, kind: "fact", answer, answered_at: new Date(T0).toISOString() });

Deno.test("2. confirmed facts but no name or email: the prepare asks for them once, instead of stopping at no_resume", async () => {
  const { profile } = await resumeConfirmed();
  const db = fakeDb();
  let engine = 0;
  const done = await prepareAhead({
    db, profileFor: async () => ({ ...profile, user_id: PERSON }),
    runEngine: async () => { engine++; return { code: 1, stdout: "", stderr: "" } as any; },
    resumeFor: tailoredResume({ render: edgeRenderer(), resumes: memoryResumeStore() }),
  });
  eq(done.map((d) => d.outcome), ["asked"], JSON.stringify(done));
  const ask = db.calls.find((x) => x.name === "career_apply_prepare_ask_for");
  assert(ask, "the questions are stored");
  eq(ask.args.p_questions.map((q: any) => q.key).sort(), ["fact:email", "fact:first_name", "fact:last_name"]);
  eq(ask.args.p_engine_job_id, "greenhouse:submittest:1", "bound to the posting, so answering them makes it a candidate again");
  eq(engine, 0, "nothing opened an employer's page");
});

Deno.test("2b. the contact questions are not asked again once answered; with no confirmed facts there is nothing to ask", async () => {
  const { profile } = await resumeConfirmed();
  const db = fakeDb({ answers: [answered("fact:first_name", "Jordan"), answered("fact:last_name", "Rivera"), answered("fact:email", "jordan.rivera@example.test")] });
  const noTailor = await prepareAhead({ db, profileFor: async () => ({ ...profile, user_id: PERSON }), runEngine: async () => ({ code: 1 } as any), resumeFor: async () => null });
  eq(noTailor.map((d) => d.outcome), ["no_resume"], "answered, and the resume still cannot be made: said, never asked again");
  const bare = fakeDb();
  const unconfirmed = conversation();
  const p = unconfirmed.turn(`here is my resume:\n${RESUME}`);
  p.save();
  const none = await prepareAhead({ db: bare, profileFor: async () => ({ ...unconfirmed.profile(), user_id: PERSON }), runEngine: async () => ({ code: 1 } as any),
    resumeFor: tailoredResume({ render: edgeRenderer(), resumes: memoryResumeStore() }) });
  eq(none.map((d) => d.outcome), ["no_resume"], "drafts only: no resume, and no contact question in its place");
  assert(!bare.calls.some((x) => x.name === "career_apply_prepare_ask_for"));
});

Deno.test("2c. with their name and email answered, the resume is tailored from their confirmed facts and the engine runs", async () => {
  const { profile } = await resumeConfirmed();
  const db = fakeDb({ answers: [answered("fact:first_name", "Jordan"), answered("fact:last_name", "Rivera"), answered("fact:email", "jordan.rivera@example.test")] });
  let engine = 0;
  await prepareAhead({
    db, profileFor: async () => ({ ...profile, user_id: PERSON }),
    runEngine: async () => { engine++; return { code: 1, stdout: "", stderr: "TEST stub engine" } as any; },
    resumeFor: tailoredResume({ render: edgeRenderer(), resumes: memoryResumeStore() }),
  });
  eq(engine, 1, "the dry run opens the posting once (the stub engine stops it there)");
});

// ---------------------------------------------------------------------------------------------- their own words
const QQ = (id: string, key: string, label: string): OpenQuestion => ({
  id, key, kind: "fact", label, type: "input_text", options: [], company: "TEST Submit Employer", job_ids: ["j1"], misfit: false, answer: null,
} as OpenQuestion);
type Said = { text: string; at: string };
function fakeStore(rows: OpenQuestion[], statements: Said[]) {
  const kv: { shown?: any } = {};
  const answers: [string, string][] = [];
  let last: string | null = null;
  const store: QuestionStore & { answers: typeof answers; setIntent(i: string | null): void } = {
    answers,
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = rows.find((x) => x.id === id)!; r.answer = a; r.misfit = false; answers.push([id, a]); },
    async shown() { return kv.shown ? JSON.parse(JSON.stringify(kv.shown)) : null; },
    async setShown(_u, s) { kv.shown = JSON.parse(JSON.stringify(s)); },
    async lastAssistantIntent() { return last; },
    statements: async () => statements,
  };
  return store;
}
async function say(store: ReturnType<typeof fakeStore>, message: string) {
  const r = await questionsTurn({ message, userId: PERSON, threadId: "t", now: T0, store });
  if (r) store.setIntent(["shown", "partial", "answered_next"].includes(r.status) || r.status.startsWith("draft") ? QUESTIONS_INTENT : "career_apply_questions_answer");
  return r;
}
const day = (d: string) => `${d}T14:00:00.000Z`;
const CONTACT = () => [
  QQ("q-first", "fact:first_name", "First name"), QQ("q-last", "fact:last_name", "Last name"),
  QQ("q-email", "fact:email", "Email"), QQ("q-phone", "fact:phone", "Phone"),
];

Deno.test("3. name, email and phone said in chat are offered back word for word, with the date; only 'use N' saves them", async () => {
  const store = fakeStore(CONTACT(), [
    { text: "my name is Jordan Rivera", at: day("2026-10-24") },
    { text: "my email is jordan.rivera@example.test", at: day("2026-10-24") },
    { text: "my phone number is 312-555-0142", at: day("2026-10-25") },
  ]);
  // One question per message (review of #360): each is offered with their own words as it is asked; "use 1" saves it.
  const r = await say(store, "what do you need from me");
  assert(r && r.status === "shown", JSON.stringify(r));
  eq(store.answers, [], "showing saves nothing");
  const seen = [r.reply];
  for (const n of [1, 2, 3, 4]) {
    const u = await say(store, "use 1");
    assert(/Saved, as drafted/.test(u?.reply ?? ""), `question ${n}: ${u?.reply}`);
    seen.push(u!.reply);
  }
  const all = seen.join("\n");
  for (const q of [`"my name is Jordan Rivera"`, `"my email is jordan.rivera@example.test"`, `"my phone number is 312-555-0142"`]) assert(all.includes(q), all);
  assert(/Oct 24/.test(all) && /Oct 25/.test(all), "the dates they said it: " + all);
  eq(store.answers, [["q-first", "Jordan"], ["q-last", "Rivera"], ["q-email", "jordan.rivera@example.test"], ["q-phone", "312-555-0142"]]);
});

Deno.test("3b. someone else's number, a question, a hedge, or a one-word name offer nothing they did not say", () => {
  const at = day("2026-10-25");
  eq(contactDraft("phone", [{ text: "my sister's phone number is 312-555-9999", at }]), null, "someone else's");
  eq(contactDraft("phone", [{ text: "is my phone number 312-555-0142?", at }]), null, "a question");
  eq(contactDraft("email", [{ text: "my email is changing soon, maybe jr@example.test", at }]), null, "a maybe");
  eq(contactDraft("phone", [{ text: "my phone number is 12", at }]), null, "not a phone number");
  eq(contactDraft("first_name", [{ text: "my name is Jordan", at }])?.value, "Jordan");
  eq(contactDraft("last_name", [{ text: "my name is Jordan", at }]), null, "one name is not a last name");
  eq(contactDraft("last_name", [{ text: "my name is Maria de la Cruz", at }]), null, "a name of more than two words is split only by them");
  eq(contactDraft("first_name", [{ text: "my name isn't Jordan", at }]), null);
  eq(contactDraft("email", [{ text: "my email is old@example.test", at: day("2026-10-20") }, { text: "my new email is new@example.test", at: day("2026-10-24") }])?.value,
    "new@example.test", "the newest decides");
  eq(contactDraft("email", [{ text: "my email is old@example.test", at: day("2026-10-20") }, { text: "my email is not that one anymore", at: day("2026-10-24") }]), null,
    "a newer unclear message about it offers nothing");
});

Deno.test("3c. the production store reads the person's messages about their name, email and phone too", async () => {
  let filter = "";
  const chain: any = (data: unknown) => {
    const q: any = { select: () => q, eq: () => q, in: () => q, limit: () => q, order: () => q, or: (f: string) => { filter = f; return q; },
      then: (ok: any) => ok({ data, error: null }) };
    return q;
  };
  const admin = { from: (t: string) => chain(t === "agent_threads" ? [{ id: "t1" }] : []) };
  await supabaseQuestionStore(admin).statements!(PERSON);
  for (const w of ["sponsor", "authori", "name is", "email", "phone"]) assert(filter.includes(`%${w}%`), `reads messages naming "${w}": ${filter}`);
});

// ---------------------------------------------------------------------------------------------- read back
const NOW = Date.parse("2026-10-25T15:00:00Z");
const row = (company: string, state: string, more: Partial<AppRow> = {}): AppRow =>
  ({ id: crypto.randomUUID(), company, state, created_at: "2026-10-24T16:00:00Z", updated_at: "2026-10-24T16:00:00Z", title: "TEST Analyst", ...more });
const ROWS = [
  row("Acme", "confirmed", { confirmation_id: "ACME-1", email_confirmed_at: "2026-10-24T18:00:00Z" }),
  row("Globex", "submitted_unconfirmed", { confirmation_id: "CONF-4242" }),
  row("Initech", "unknown_outcome"),
  row("Umbrella", "queued"),
  row("Hooli", "not_submitted", { reason: "the employer's page changed after you approved it" }),
];
const ask = (message: string, rows: AppRow[] | null = ROWS) => statusReply(message, rows, NOW);

Deno.test("4. 'did my application go through' is answered from career_apply_jobs; success only with the employer's confirmation", () => {
  const acme = ask("did my application to Acme go through?");
  assert(acme && /Acme confirmed it/.test(acme.reply) && /ACME-1/.test(acme.reply), JSON.stringify(acme));
  const globex = ask("did my application to globex go through");
  assert(globex && /submitted/i.test(globex.reply) && /has not confirmed it yet/.test(globex.reply), JSON.stringify(globex));
  assert(!/Globex confirmed|went through|was successful/i.test(globex.reply), "never a success it did not see: " + globex.reply);
  const initech = ask("did you apply to Initech?");
  assert(initech && /can't tell whether it reached Initech/.test(initech.reply) && /not be sent again/.test(initech.reply), JSON.stringify(initech));
  const umbrella = ask("was my application to Umbrella submitted?");
  assert(umbrella && /not sent yet/.test(umbrella.reply), JSON.stringify(umbrella));
  const hooli = ask("did my application to Hooli go through?");
  assert(hooli && /not sent/i.test(hooli.reply) && /page changed/.test(hooli.reply), JSON.stringify(hooli));
  const stark = ask("did my application to Stark Industries go through?");
  assert(stark && /no application to Stark Industries on record/.test(stark.reply), JSON.stringify(stark));
  eq(acme.intent, STATUS_INTENT);
});

Deno.test("4b. 'where are my applications' lists each one in its recorded state; an unreadable record is said, never guessed", async () => {
  const all = ask("where are my applications");
  assert(all, "answered");
  for (const c of ["Acme", "Globex", "Initech", "Umbrella", "Hooli"]) assert(all.reply.includes(c), `${c}: ${all.reply}`);
  const down = await applicationsTurn({ message: "did my application to Acme go through?", userId: PERSON, now: NOW, read: async () => { throw new Error("TEST: down"); } });
  assert(down && /couldn't read your applications/.test(down.reply) && !/confirmed/.test(down.reply), JSON.stringify(down));
  let reads = 0;
  eq(await applicationsTurn({ message: "find me data analyst roles in Chicago", userId: PERSON, now: NOW, read: async () => { reads++; return ROWS; } }), null,
    "anything else goes on to the chat as before");
  eq(reads, 0, "and is never read for");
  eq(ask("apply to Acme"), null);
});

Deno.test("4c. agent-chat answers the status ask from career_apply_jobs, before the router or the brain", async () => {
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  const at = src.indexOf("applicationsTurn(");
  assert(at > 0, "the handler calls it");
  assert(at < src.indexOf("AGENT_BRAIN_RELEASED && chooseBrain"), "before the brain and the router");
  assert(/read: supabaseApplications\(admin\)/.test(src), "reading the queue's own record");
  const mod = await Deno.readTextFile(`${ROOT}/supabase/functions/_shared/career_apply_status.ts`);
  assert(/from\("career_apply_jobs"\)/.test(mod) && !/from\("(?!career_apply_jobs)/.test(mod), "career_apply_jobs only");
});
