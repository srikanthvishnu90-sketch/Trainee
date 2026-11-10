// H2H LEFTOVERS (architect, 2026-11-10): four gaps docs/architect/INSTINCT-HEAD-TO-HEAD.md and its review left open after the
// h2h fixes (#727). Each was failing on ag/h2h-fixes 76a02f64.
//   1 contact  tailor_resume refused without a name and email typed in chat, though the person had confirmed a resume header:
//              a header with a name and no email (A.4's shape) was answered "What name and email ...?" (item 3, check 13).
//              It uses the confirmed header, and asks for exactly the piece that is missing; it never invents one.
//   2 plural   "referrals" was not read where "referral" is: a form question "Referrals" or "Do you have any referrals at the
//              company?" mapped to no rule, and "get me referrals at Stripe" was not an introduction ask.
//   3 packet   C3 t6, "Never mind, just send me the packet." with no packet in the thread: the reply must say there is no
//              packet yet and what can be done, never "Here is the review packet".
//   4 scope    a per-employer answer (veteran, disability, gender: question_map.ts keys it to one posting) was answered
//              "Saved. I won't ask this again", though the next employer asks it again.
import assertNode from "node:assert/strict";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender, CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryPersonaStore, memoryResumeStore, resumeContact, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { answerKey, mapQuestion } from "../../supabase/functions/_shared/question_map.ts";
import { parseConnectorAsk } from "../../supabase/functions/_shared/career_connector.ts";
import { type OpenQuestion, type QuestionStore, QUESTIONS_INTENT, questionsTurn } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { checkReply } from "../../supabase/functions/_shared/reply_rubric.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { B6 } from "./helpers/b6_continuations.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const NOW = Date.UTC(2026, 10, 10, 15);
const USER = "00000000-0000-4000-8000-000000001110";
const pdfText = (pdf: Uint8Array) => (R.extractPdfLines(Buffer.from(pdf)) as string[]).join("\n");

// ---------------------------------------------------------------------------------------------------- 1 contact
// A fictional TEST resume. HEAD_FULL carries a name, a city and an email at the top; HEAD_NAME a name and a city only (A.4's
// shape: Instinct's intake had no email or phone).
const BODY = `EDUCATION
TEST State University, B.A. Economics, May 2027

EXPERIENCE
Data Analyst Intern, TEST Transit Co, Jun 2025 - Aug 2025
- Built a weekly ridership dashboard in Excel and SQL for three operations managers
- Cleaned and joined fare and schedule tables covering 40 routes
Private Equity Intern, TEST Capital Partners, Jan 2025 - May 2025
- Built a Python screening workflow that combined company and revenue data across 100+ targets

SKILLS
Python, SQL, Excel`;
const HEAD_FULL = `Riley Fixture (TEST)\nChicago, IL (TEST) | riley.fixture@example.test`;
const HEAD_NAME = `Riley Fixture (TEST)\nChicago, IL (TEST)`;
const POSTING = `Data Analyst Intern, Acme Analytics (TEST posting)
About the role: build reporting for internal teams.
Requirements:
- SQL and Python
- Build dashboards in Excel for internal users`;
const EMAIL_Q = "What email should go at the top of your resume?";
const BOTH_Q = "What name and email should go at the top of your resume?";

// The person pastes the resume and says yes in chat (the router's own intake and header confirmation, 142).
function confirmedFrom(head: string | null) {
  const ctx: any = { now: NOW, thread: {} };
  CareerRouter.handleChat(`here is my resume:\n${head ? `${head}\n\n` : ""}${BODY}`, ctx);
  CareerRouter.handleChat("yes, that's my resume", ctx);
  assertNode.ok((ctx.profile?.facts ?? []).some((f: any) => f.kind === "experience" && f.status !== "draft"), "the entries are confirmed");
  assertNode.ok(!ctx.profile.basics?.name && !ctx.profile.basics?.email, "nothing typed for the resume");
  return ctx.profile;
}
function tools() {
  const store = memoryResumeStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer() } } as any).map((x: any) => [x.name, x]));
  return { t, store };
}
const ctx = (profile: any, message = "make me a resume for this posting") => ({ userId: USER, threadId: "t1", now: NOW, state: { profile } as Record<string, any>, turn: { message, added: [] as string[] } });
async function rejection(f: () => Promise<unknown>): Promise<string> {
  try { await f(); } catch (e) { return String((e as Error).message); }
  throw new Error("did not reject");
}

Deno.test("1a a confirmed header with a name and an email: tailor_resume makes the file from it, with nothing typed in chat", async () => {
  const p = confirmedFrom(HEAD_FULL);
  assertNode.equal(p.resume_header?.email, "riley.fixture@example.test");
  assertNode.ok(p.resume_header?.confirmed_at, "confirmed at the person's yes");
  const { t, store } = tools();
  const r = await t.tailor_resume.run({ posting_text: POSTING }, ctx(p)) as any;
  assertNode.ok(r.link && store.files.size === 1, JSON.stringify(r).slice(0, 300));
  const text = pdfText([...store.files.values()][0]);
  assertNode.ok(text.includes("Riley Fixture (TEST)") && text.includes("riley.fixture@example.test"), text.slice(0, 300));
});

Deno.test("1b a confirmed header with a name and no email (A.4's shape): the name is used and only the email is asked", async () => {
  const p = confirmedFrom(HEAD_NAME);
  assertNode.deepStrictEqual([p.resume_header?.name, p.resume_header?.email ?? null], ["Riley Fixture (TEST)", null]);
  assertNode.deepStrictEqual(resumeContact(p), { name: "Riley Fixture (TEST)", email: null });
  const o = await tailorForPosting({ userId: USER, profile: p, posting: { text: POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assertNode.ok(!o.ok && o.refused === "no_contact" && o.reason.includes(EMAIL_Q) && !o.reason.includes(BOTH_Q), JSON.stringify(o));
  const { t, store } = tools();
  const msg = await rejection(() => t.tailor_resume.run({ posting_text: POSTING }, ctx(p)));
  assertNode.ok(msg.includes(`Ask exactly: "${EMAIL_Q}"`) && !/name and email/.test(msg), msg);
  assertNode.equal(store.files.size, 0, "nothing stored on a refusal");
  // The person types the email alone; the name stays the one they confirmed.
  const { t: t2, store: store2 } = tools();
  const s = await t2.set_resume_contact.run({ email: "riley.fixture@example.test" }, ctx(p, "it's riley.fixture@example.test")) as any;
  assertNode.equal(s.restated, "Your resume will show Riley Fixture (TEST) and riley.fixture@example.test at the top.");
  assertNode.equal(p.basics?.name ?? null, null, "the confirmed name is not copied into a typed one");
  const r = await t2.tailor_resume.run({ posting_text: POSTING }, ctx(p)) as any;
  assertNode.ok(r.link && store2.files.size === 1, JSON.stringify(r).slice(0, 300));
  const text = pdfText([...store2.files.values()][0]);
  assertNode.ok(text.includes("Riley Fixture (TEST)") && text.includes("riley.fixture@example.test"), text.slice(0, 300));
});

Deno.test("1c never invented: no header and nothing typed asks for both; an email not typed, an unconfirmed header, a name alone are refused", async () => {
  const none = confirmedFrom(null);
  assertNode.equal(none.resume_header ?? null, null);
  const { t } = tools();
  assertNode.ok((await rejection(() => t.tailor_resume.run({ posting_text: POSTING }, ctx(none)))).includes(`Ask exactly: "${BOTH_Q}"`));
  // With no name anywhere, an email alone is not enough to save: the name is asked for.
  const nameless = await rejection(() => t.set_resume_contact.run({ email: "riley.fixture@example.test" }, ctx(none, "riley.fixture@example.test")));
  assertNode.ok(/name/.test(nameless) && nameless.includes(BOTH_Q), nameless);
  // An email the person did not type is refused, whatever the header says.
  const p = confirmedFrom(HEAD_NAME);
  assertNode.ok(/did not type that email/.test(await rejection(() => t.set_resume_contact.run({ email: "riley@account.example.test" }, ctx(p, "use my usual email")))));
  assertNode.equal(p.basics?.email ?? null, null, "nothing saved by a refusal");
  // A header never confirmed (no confirmed_at) holds nothing for the top of the file.
  const q = confirmedFrom(HEAD_FULL);
  q.resume_header = { ...q.resume_header, confirmed_at: null };
  const o = await tailorForPosting({ userId: USER, profile: q, posting: { text: POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW });
  assertNode.ok(!o.ok && o.refused === "no_contact" && o.reason.includes(BOTH_Q), JSON.stringify(o));
  // The form path (prepare-ahead) still takes only typed contact details.
  const form = await tailorForPosting({ userId: USER, profile: confirmedFrom(HEAD_FULL), posting: { text: POSTING }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, contact: "typed" });
  assertNode.ok(!form.ok && form.refused === "no_contact", JSON.stringify(form));
});

// ---------------------------------------------------------------------------------------------------- 2 plural
Deno.test("2 'referrals' routes where 'referral' does: the form question map and the introductions ask", () => {
  const map = (label: string) => mapQuestion({ label, type: "text", options: [] } as any);
  for (const [one, many] of [["Referral", "Referrals"], ["Do you have a referral at the company?", "Do you have any referrals at the company?"], ["Employee referral (name)", "Employee referrals (names)"]]) {
    assertNode.equal(map(one).fact, "referral", one);
    assertNode.deepStrictEqual([map(many).fact, map(many).kind], [map(one).fact, map(one).kind], many);
    assertNode.equal(answerKey({ label: many, type: "text", options: [] } as any, "gh:a").slice(0, 4), answerKey({ label: one, type: "text", options: [] } as any, "gh:a").slice(0, 4), many);
  }
  // The guard that keeps "do you personally know a public official" out of it holds for the plural too.
  assertNode.notEqual(map("Referrals: do you personally know a government official?").fact, "referral");
  for (const [one, many] of [["get me a referral at Stripe", "get me referrals at Stripe"], ["can you get me a referral to Ramp", "can you get me referrals to Ramp"]]) {
    assertNode.deepStrictEqual(parseConnectorAsk(many), parseConnectorAsk(one), many);
    assertNode.equal((parseConnectorAsk(one) as any)?.need, "referral", one);
  }
  assertNode.deepStrictEqual(parseConnectorAsk("i can give a referral to students at Stripe"), parseConnectorAsk("i can give referrals to students at Stripe"));
  assertNode.equal((parseConnectorAsk("i can give referrals to students at Stripe") as any)?.offer, "referral");
});

// ---------------------------------------------------------------------------------------------------- 3 packet
const PACKET = "Never mind, just send me the packet.";
const NO_PACKET = /\bno application packet\b/i;
Deno.test("3a the router: a packet asked for with none in the thread is said to be absent, with what can be done, ending at one question", () => {
  const c: any = { now: NOW, thread: {}, profile: confirmedFrom(HEAD_FULL) };
  const r = CareerRouter.handleChat(PACKET, c);
  assertNode.ok(r && r.intent !== "career_document_delivery", `${r?.intent}`);
  assertNode.match(r.reply, NO_PACKET);
  assertNode.ok(!/\bhere is\b|\battached\b|no resume has been tailored/i.test(r.reply), r.reply);
  assertNode.match(r.reply, /\bprepare\b/i, "what can be done");
  assertNode.ok(r.reply.trim().endsWith("?") && (r.reply.match(/\?/g) ?? []).length === 1, r.reply);
  assertNode.equal(r.sends ?? 0, 0);
  assertNode.deepStrictEqual(checkReply({ ask: PACKET, reply: r.reply, timeZone: ZONE }).violations, []);
  // A resume asked for is still the resume answer; a packet ask with a resume file on hand is unchanged.
  assertNode.equal(CareerRouter.handleChat("send me my resume", { now: NOW, thread: {}, profile: confirmedFrom(HEAD_FULL) } as any)?.intent, "career_document_delivery");
});

Deno.test({
  name: "3b C3 t6 through the real handler, staged brain on Instinct's targets: the reply says there is no packet yet",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: h2h leftovers handler part not run`); return; }
    const turns = B6.flatMap((c) => c.turns);
    const scripted = (chat: any) => {
      const last = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
      const hit = turns.filter((t) => last.includes(t.say)).sort((a, b) => b.say.length - a.say.length)[0];
      return Response.json({ id: "h2h", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : hit?.target ?? "I can't answer that from this chat yet." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(2, { model: (req) => anthropicWire(req, scripted) });
    try {
      for (const brain of ["staged", "router"]) {
        Deno.env.set("CAREER_BRAIN", brain);
        if (brain === "staged") Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real"); else Deno.env.delete("ANTHROPIC_API_KEY");
        const p = await w.person({ resume: true });
        const S1 = "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.";
        for (const m of [S1, ...B6[2].turns.slice(0, 5).map((t) => t.say)]) await p.say(m);
        const r = await p.say(B6[2].turns[5].say);
        assertNode.equal(r.status, 200);
        assertNode.equal(B6[2].turns[5].say, PACKET);
        assertNode.ok(NO_PACKET.test(r.reply) && !/here is the (?:review )?packet|no resume has been tailored/i.test(r.reply), `${brain}: ${r.intent}: ${r.reply}`);
        assertNode.ok(r.intent !== "career_document_delivery", `${brain}: ${r.intent}`);
      }
      assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});

// ---------------------------------------------------------------------------------------------------- 4 scope
const T = Date.UTC(2026, 10, 10, 15);
const q = (o: Partial<OpenQuestion>): OpenQuestion => ({
  id: "q1", key: "label:0000000000000001", kind: "unknown", label: "Question?", type: "input_text", options: [], company: null, job_ids: ["gh:a"],
  misfit: false, answer: null, ...o,
});
function fakeStore(rows: OpenQuestion[]) {
  const kv: Record<string, any> = {};
  let last: string | null = null;
  const store: QuestionStore & { setIntent(i: string | null): void } = {
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = rows.find((x) => x.id === id)!; r.answer = a; r.misfit = false; },
    async shown() { return kv.shown ?? null; },
    async setShown(_u, s) { kv.shown = s; },
    async lastAssistantIntent() { return last; },
  };
  return store;
}
const YN = ["Yes", "No"];
const VETERAN = "Are you a protected veteran?";

Deno.test("4 a per-employer answer is said to be for that application only; an answer for every employer still says it won't be asked again", async () => {
  // The keys question_map.ts gives: self-identification is one posting's; sponsorship is the person's for every employer.
  assertNode.ok(answerKey({ label: VETERAN, type: "select", options: YN.map((label) => ({ label })) } as any, "gh:a").startsWith("job:"));
  const rows = [
    q({ id: "v", key: answerKey({ label: VETERAN, type: "select", options: YN.map((label) => ({ label })) } as any, "gh:a"), kind: "fact", label: VETERAN, type: "select", options: YN, company: "Ramp" }),
    q({ id: "s", key: "fact:sponsorship", kind: "fact", label: "Will you require sponsorship?", type: "select", options: YN }),
    q({ id: "g", key: "job:00000000000000dd", kind: "fact", label: "Gender", type: "select", options: ["Female", "Male", "Decline to self-identify"], company: "Ramp" }),
  ];
  const store = fakeStore(rows);
  const asked = await questionsTurn({ message: "what do you need from me", userId: "u", threadId: "t", now: T, store });
  assertNode.ok(asked && asked.reply.includes(VETERAN), asked?.reply);
  assertNode.ok(!/won't ask again/.test(asked!.reply), `the per-employer question is not promised once: ${asked!.reply}`);
  store.setIntent(QUESTIONS_INTENT);
  const a1 = await questionsTurn({ message: "no", userId: "u", threadId: "t", now: T, store });
  assertNode.equal(a1!.status, "answered_next", a1!.reply);
  assertNode.ok(!/won't ask this again/.test(a1!.reply.split("\n\nNext:")[0]), a1!.reply);
  assertNode.match(a1!.reply, /^Saved for your Ramp application only/);
  // Sponsorship is the person's for every employer: the promise stands.
  const a2 = await questionsTurn({ message: "no", userId: "u", threadId: "t", now: T, store });
  assertNode.match(a2!.reply, /^Saved\. I won't ask this again:/);
  // The last one, a per-employer answer, with nothing left open.
  const a3 = await questionsTurn({ message: "decline to self-identify", userId: "u", threadId: "t", now: T, store });
  assertNode.equal(a3!.status, "answered", a3!.reply);
  assertNode.ok(!/won't ask/.test(a3!.reply) && /^Saved for your Ramp application only/.test(a3!.reply), a3!.reply);
  for (const r of [a1!, a2!, a3!]) assertNode.deepStrictEqual(checkReply({ ask: "no", reply: r.reply }).violations.filter((v) => v.rule === "leaked_instruction" || v.rule === "internal"), [], r.reply);
});
