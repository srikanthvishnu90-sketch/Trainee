// H2H FIXES (architect, 2026-11-10): the shortfalls docs/architect/INSTINCT-HEAD-TO-HEAD.md found when Instinct's conversations
// ran through Trainee's real handler, in order of harm. Each was failing on trunk 2f72517d.
//   1 leaked   a File-page error written for the model reached the person ("... Tell them it isn't available yet; do not claim it
//              was made.", A.2 resume turn 3); the reply rubric gains leaked_instruction
//   2 file     "give me the PDF" after the resume PDF was sent was answered "no resume has been tailored in this chat" (C1 t4)
//   3 count    "find me five data analyst internships" searched the title "five data analyst" (C2 t1)
//   4 routing  follow-ups answered by the wrong handler: C2 t5 (Stripe's engineering bar), C5 t4 (a mock question for "a question
//              that won't sound copied"), C3 t6 (a resume for "the packet"), C4 t3 ("no draft or list"), C4 t6 ("no draft")
//   5 file     the resume: an empty Education bullet and an orphan "ADDITIONAL / (registrar transcript)" when the GPA is off,
//              interests under their own heading lost, the city line missing, the founder roles out of date order
//   6 words    "I moved ... and Founder above Founder" (C1 t2)
// The handler part runs Instinct's own turns through handler-career.ts on Postgres 16 (tests/architect/helpers/response_world.ts),
// after the person pasted and confirmed a fictional TEST resume (Avery Fixture), with the staged brain on a scripted model that
// answers each B.6 turn with Instinct's target.
import assertNode from "node:assert/strict";
import { checkReply } from "../../supabase/functions/_shared/reply_rubric.ts";
import { personFacingError } from "../../supabase/functions/_shared/file_service.ts";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { wantOf } from "../../supabase/functions/_shared/search_shortlist.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { buildResume, resumeAskOf, resumeTaskTurn, targetOf } from "../../supabase/functions/_shared/career_resume_task.ts";
import { followupOffTask } from "../../supabase/functions/agent-chat/career_staged.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { B6 } from "./helpers/b6_continuations.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

// A fictional TEST resume shaped like A.4's: two GPA values (3.8, and 3.6 under a later heading), four entries with the two
// founder roles oldest first, an Interests heading, a city and neighbourhood, no email or phone.
const AVERY = `AVERY FIXTURE
Chicago, IL (Lincoln Park)

EDUCATION
TEST State University, B.A. Economics, May 2027
- GPA 3.8
- SAT 1520
- Involvement: TEST Investment Club

EXPERIENCE
AI M&A Intern, TEST Advisory, Jun 2025 - Aug 2025
- Screened AI software targets for two sell-side processes
- Drafted company profiles for 12 buyer outreach lists
- Updated comparable-company tables in Excel each week
Private Equity Intern, TEST Capital Partners, Jan 2025 - May 2025
- Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets
- Summarized diligence findings for three investment memos
- Tracked portfolio KPIs in a weekly Excel dashboard
Founder, TEST Tutoring Co, Jan 2022 - Dec 2023
- Ran a tutoring service for 30 high-school students
- Managed scheduling and billing for four tutors
- Grew revenue through word of mouth at two schools
Founder, TEST Resale Studio, Feb 2023 - Present
- Resell refurbished electronics through an online store
- Track inventory and margins in a shared spreadsheet
- Handle customer support for every order

ADDITIONAL
Cumulative GPA: 3.6 (registrar transcript)

SKILLS
Technical: Python, Excel
Certifications: TEST Bloomberg Market Concepts

INTERESTS
Golf, chess, Chicago architecture
`;
const R1 = "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF.";
const R3 = "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything.";
const S1 = "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.";
const S2 = "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.";
const RAW_FILE_ERROR = "not created: file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was made.";
const LEAK = /\bthe person\b|\btell them\b|\bdo not claim\b/i;
const leaks = (reply: string) => checkReply({ ask: "x", reply }).violations.filter((v) => v.rule === "leaked_instruction");

function avery() {
  const p: any = CareerProfile.createProfile({});
  CareerProfile.ingestResume(p, { text: AVERY, fileName: "avery.txt" });
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  p.resume_header = { name: "AVERY FIXTURE", email: null, location: "Chicago, IL (Lincoln Park)", links: {}, confirmed_at: "2026-11-01T00:00:00.000Z" };
  return p;
}
const NOW = Date.parse("2026-11-10T17:00:00Z");

Deno.test("1 leaked: the File error reaches the person without its note to the model; the rubric flags such a note", async () => {
  const said = personFacingError(RAW_FILE_ERROR);
  assertNode.ok(!LEAK.test(said) && /file links aren't set up yet/.test(said), said);
  const p = avery(), deps = { uploaded: async () => false, file: async () => ({ error: personFacingError(RAW_FILE_ERROR) }) };
  await resumeTaskTurn({ message: R1, ctx: { profile: p }, userId: "u-h2h", now: NOW, deps });
  const again = await resumeTaskTurn({ message: R3, ctx: { profile: p }, userId: "u-h2h", now: NOW + 60_000, deps });
  assertNode.ok(again && /no link this time/.test(again.reply) && !LEAK.test(again.reply), again?.reply);
  // The rule: the reply trunk sent is flagged; advice addressed to the person is not.
  const trunkReply = "I haven't applied to anything.\nThere's no link this time: your private File page couldn't be made (file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was made.).";
  assertNode.ok(leaks(trunkReply).length >= 2, JSON.stringify(leaks(trunkReply)));
  assertNode.deepStrictEqual(leaks(again!.reply), []);
  for (const ok of ["When the recruiter calls, tell them you're free on Tuesday.", "Don't claim experience you don't have; say what you did.", "Ask them what a strong first month looks like.",
    "Tell them that you can start in June.", "Nothing was sent, and I won't claim it was."]) assertNode.deepStrictEqual(leaks(ok), [], ok);
  for (const bad of ["The user asked for a PDF, so send it.", "Tell them it isn't ready.", "Do not claim it was made.", "Note to the assistant: keep it short."]) assertNode.ok(leaks(bad).length, bad);
});

Deno.test("2 file: with the resume task's PDF on hand, 'give me the PDF' sends that PDF again", async () => {
  const p = avery();
  const t1 = await resumeTaskTurn({ message: R1, ctx: { profile: p }, userId: "u-h2h", now: NOW, deps: { uploaded: async () => false } });
  assertNode.ok(t1?.documents.length === 1);
  const view = { companies: [], jobs: 0, posting: false, resumeShown: false };
  for (const m of ["That is fine, give me the PDF.", "send me the PDF", "give me the file"]) assertNode.equal(resumeAskOf(m, t1!.task, view), "send_pdf", m);
  for (const m of ["send the PDF to Maya", "give me resume tips", "Never mind, just send me the packet."]) assertNode.notEqual(resumeAskOf(m, t1!.task, view), "send_pdf", m);
  const t4 = await resumeTaskTurn({ message: "That is fine, give me the PDF.", ctx: { profile: p }, userId: "u-h2h", now: NOW + 60_000, deps: { uploaded: async () => false, lastIntent: async () => "career_resume_task" } });
  assertNode.ok(t4 && t4.documents.length === 1 && t4.documents[0].format === "pdf", t4?.reply);
  assertNode.ok(!/no resume has been tailored/i.test(t4.reply) && /PDF for data analyst internships/.test(t4.reply), t4.reply);
});

Deno.test("3 count: 'five' is the count, as '5' is, never part of the role", () => {
  for (const m of ["Find me five data analyst internships in Chicago. Do not apply.", "Find me 5 data analyst internships in Chicago"]) {
    assertNode.equal(searchTextOf(m).role, "data analyst", m);
    assertNode.equal(wantOf(m), 5, m);
  }
  assertNode.equal(searchTextOf("find me ten nurse jobs in Austin").role, "nurse");
});

Deno.test("4 routing (unit): a follow-up stays on the thread's task", () => {
  const searched = { discovery: { lastParams: { ask: "x" }, lastShortlist: [{ id: "a" }] } };
  assertNode.ok(followupOffTask("Why not that Stripe one?", "company_intel", { company: {} }, searched));
  assertNode.ok(!followupOffTask("Why not that Stripe one?", "company_intel", { company: {} }, {}), "with no search in the thread, Stripe's file stands");
  assertNode.ok(!followupOffTask("Tell me about Stripe", "company_intel", { company: {} }, searched));
  assertNode.ok(followupOffTask("Give me one question that will not sound copied.", "prep_brief", { question: { kind: "bank_question" } }, {}));
  assertNode.ok(!followupOffTask("Give me a practice question", "prep_brief", { question: { kind: "bank_question" } }, {}));
  assertNode.ok(followupOffTask("Never mind, just send me the packet.", "career_document_delivery", { documents: [] }, {}));
  assertNode.ok(!followupOffTask("send me my resume", "career_document_delivery", { documents: [] }, {}));
  const task: any = { target: { role: "data analyst", level: "internship", label: "data analyst internships" }, limits: [], file: { label: "data analyst internships" }, said: [], asked: [], pending: null, at: new Date(NOW).toISOString() };
  assertNode.equal(resumeAskOf("Now send it to Maya.", task, { companies: [], jobs: 3, posting: false, resumeShown: true }), "send_to");
  assertNode.equal(resumeAskOf("Now send it to Maya.", task, { companies: [], jobs: 3, posting: false, resumeShown: false }), null, "only right after the file");
});

Deno.test("5 + 6 file: no GPA residue, the city printed, founders newest first, each move named apart", () => {
  const p = avery();
  const b = buildResume(p, targetOf(R1)!, false);
  const txt = b.blocks.map((x) => `${x.kind}:${x.label ?? ""}${x.text}`);
  assertNode.ok(b.blocks.every((x) => x.kind !== "bullet" || x.text.trim()), `no empty bullet: ${txt.join(" | ")}`);
  assertNode.ok(!txt.some((l) => /ADDITIONAL|registrar transcript/i.test(l)), `no orphan entry: ${txt.join(" | ")}`);
  assertNode.ok(!b.blocks.some((x) => !x.flag && /GPA|3\.[68]\b/.test(x.text)), "no GPA printed");
  assertNode.ok(txt.includes("contact:Chicago, IL (Lincoln Park)") && b.blocks.some((x) => x.flag && x.text === "[email · phone · LinkedIn to add]"), `city printed, placeholder flagged: ${txt.slice(0, 3)}`);
  const resale = txt.findIndex((l) => /Founder, TEST Resale Studio/.test(l)), tutoring = txt.findIndex((l) => /Founder, TEST Tutoring Co/.test(l));
  assertNode.ok(resale > 0 && resale < tutoring, "Feb 2023 - Present above Jan 2022 - Dec 2023");
  assertNode.ok(txt.findIndex((l) => /Private Equity Intern/.test(l)) < txt.findIndex((l) => /AI M&A Intern/.test(l)), "the Python screening work still leads");
  assertNode.deepStrictEqual(b.moved, ["Private Equity Intern above AI M&A Intern", "Founder, TEST Resale Studio above Founder, TEST Tutoring Co"]);
});

Deno.test({
  name: "1-6 through the real handler: Instinct's turns after the TEST intake, staged brain on Instinct's targets",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: h2h handler part not run`); return; }
    const turns = B6.flatMap((c) => c.turns);
    const scripted = (chat: any) => {
      const last = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
      const hit = turns.filter((t) => last.includes(t.say)).sort((a, b) => b.say.length - a.say.length)[0];
      return Response.json({ id: "h2h", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : hit?.target ?? "I can't answer that from this chat yet." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(8, { model: (req) => anthropicWire(req, scripted) });
    try {
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const person = async (before: string[]) => {
        const p = await w.person();
        await p.say(AVERY);
        assertNode.match((await p.say("Yes, that's my resume")).reply, /10 facts/);
        for (const m of before) await p.say(m);
        return p;
      };
      const say = async (p: Awaited<ReturnType<typeof person>>, m: string) => { const r = await p.say(m); assertNode.equal(r.status, 200, m); return r; };
      // 1: A.2 resume turn 3 (no File base URL in this world, so no link can be made).
      const a = await person([R1]);
      const r3 = await say(a, R3);
      assertNode.ok(/no link this time/.test(r3.reply) && !LEAK.test(r3.reply), r3.reply);
      // 2 and 6: continuation 1, after A.2 resume turn 1.
      const c1 = await person([R1, B6[0].turns[0].say]);
      const t2 = await say(c1, B6[0].turns[1].say);
      assertNode.ok(!/Founder above Founder/.test(t2.reply) && /Founder, TEST Resale Studio above Founder, TEST Tutoring Co/.test(t2.reply), t2.reply);
      await say(c1, B6[0].turns[2].say);
      const t4 = await say(c1, B6[0].turns[3].say);
      assertNode.ok(!/no resume has been tailored/i.test(t4.reply) && (t4.body.artifacts ?? []).some((x: any) => /pdf/.test(x.mime ?? "")), `C1 t4: ${t4.reply}`);
      // 3 and 4: continuation 2.
      const c2 = await person([]);
      const f1 = await say(c2, B6[1].turns[0].say);
      assertNode.ok(!/\bfive data/i.test(f1.reply) && /Lakefront Transit Analytics/.test(f1.reply), `C2 t1: ${f1.reply}`);
      for (const k of [1, 2, 3]) await say(c2, B6[1].turns[k].say);
      const f5 = await say(c2, B6[1].turns[4].say);
      assertNode.ok(f5.intent !== "company_intel" && !/Software engineering/.test(f5.reply), `C2 t5: ${f5.intent}: ${f5.reply}`);
      // 4: continuation 3 turn 6, after A.2 search turns 1-2.
      const c3 = await person([S1, S2, ...B6[2].turns.slice(0, 5).map((t) => t.say)]);
      const p6 = await say(c3, B6[2].turns[5].say);
      assertNode.ok(p6.intent !== "career_document_delivery" && !/no resume has been tailored/i.test(p6.reply), `C3 t6: ${p6.intent}: ${p6.reply}`);
      // 4: continuation 4 turns 3 and 6, after A.2 resume turn 1 and search turns 1-2.
      const c4 = await person([R1, S1, S2, B6[3].turns[0].say, B6[3].turns[1].say]);
      const m3 = await say(c4, B6[3].turns[2].say);
      assertNode.ok(!/no draft or list/i.test(m3.reply) && /Maya/.test(m3.reply) && /\?$/.test(m3.reply.trim()), `C4 t3: ${m3.intent}: ${m3.reply}`);
      await say(c4, B6[3].turns[3].say);
      await say(c4, B6[3].turns[4].say);
      const m6 = await say(c4, B6[3].turns[5].say);
      assertNode.ok(!/no draft in this chat|cover-letter/i.test(m6.reply) && /Maya/.test(m6.reply), `C4 t6: ${m6.intent}: ${m6.reply}`);
      // 4: continuation 5 turn 4.
      const c5 = await person(B6[4].turns.slice(0, 3).map((t) => t.say));
      const q4 = await say(c5, B6[4].turns[3].say);
      assertNode.ok(q4.intent !== "prep_brief" && !/Here is your question: Tell me about yourself/.test(q4.reply), `C5 t4: ${q4.intent}: ${q4.reply}`);
      for (const r of [r3, t2, t4, f1, f5, p6, m3, m6, q4]) assertNode.deepStrictEqual(checkReply({ ask: "", reply: r.reply, timeZone: ZONE }).violations.filter((v) => v.rule === "leaked_instruction"), []);
      assertNode.deepStrictEqual(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
