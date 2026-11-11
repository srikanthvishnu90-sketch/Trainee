// ROUTER MIRROR FIXES (architect builder, 2026-11-11): the causes evals/mirror's $0 dry run found when the router (code-owned
// replies, no model) answered and did not do the task (164 of 467 at d1f0d450). Each case below failed on origin/ag/mirror-1000
// (802ef349). The prompts are new phrasings of each cause, not the mirror set's own text: the fixes read what a message IS
// (a guard, a way of answering, a stated limit, a hypothetical, a draft to a named person), never a prompt.
//   1 role      the guard, how to answer and the limits read elsewhere were searched as role words ("I checked just show don t
//               mid-level accountant posted recently"); an industry was taken for a place ("in Gaming"); "right now" for part of it
//   2 empty     the empty search said only "none was found" and dropped the stated limits; a short ask got the long answer
//   3 refusal   "what X jobs are open right now ... Don't apply to anything" was refused as bulk applying
//   4 pause     "if I said pause everything, what happens? Just explain, don't do it" PAUSED the account
//   5 decline   a password or code ("log in with it?") and a CAPTCHA ask got no plain no first
//   6 memory    "my graduation is December 2028, not May" kept May 2027 ("I haven't changed your graduation date")
//   7 hiring    "check <Employer>'s careers page for <role> openings" got the company file instead of that employer's roles
//   8 draft     a draft to a named person got "no resume has been tailored", the alumni list or "who should it go to?"
//   9 internal  "Live browser execution is not wired in this handler" reached the person
//  10 prep      "ask me one question and wait for my answer" served the question with no question to answer
// The handler part runs handler-career.ts on Postgres 16 (tests/architect/helpers/response_world.ts) with the staged brain on a
// scripted model ($0; every other host refused and recorded).
import assertNode from "node:assert/strict";
import { roleTextOf, searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { namedDraftAsk } from "../../supabase/functions/_shared/outreach_ask.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const MODEL_LINE = "SCRIPTED-DRAFT: the brain drafted this turn.";
const prose = (s: string) => s.replace(/\n\s*\d+\.\s[^\n]*/g, "").trim();

Deno.test("1 role: the guard, the way of answering and the stated limits are never role words; an industry is not a place", () => {
  const cases: [string, string, string | null][] = [
    ["Just show me, don't apply: any mid-level accountant positions posted recently?", "mid-level accountant", null],
    ["Hold off on applying. Which logistics coordinator jobs are open in Denver right now, hybrid is fine, part-time, and I can't start before May.", "logistics coordinator", "denver"],
    ["I'll decide on applying later, so don't apply: UX researcher jobs in gaming, startups under 50 people.", "ux researcher", null],
    ["Search only, nothing submitted: find dietitian roles in Tulsa, give me exactly 2, and tell me where you looked.", "dietitian", "tulsa"],
    ["No applying yet: jobs that use Looker and SQL in Boise. Leave out staffing agencies; posted in the last week.", "looker sql", "boise"],
  ];
  for (const [m, role, place] of cases) {
    const st = searchTextOf(m);
    assertNode.equal(st.role, role, `${m} -> ${JSON.stringify(st)}`);
    assertNode.equal(st.place, place, m);
  }
  assertNode.equal(searchTextOf("is Spotify hiring any data engineers. Only looking.").limits.company, "Spotify");
  assertNode.equal(searchTextOf("check Pinterest's careers page for designer openings, don't queue anything").limits.company, "Pinterest");
  assertNode.equal(searchTextOf("check Pinterest's careers page for designer openings, don't queue anything").role, "designer");
  // The role words themselves are kept as said.
  assertNode.match(roleTextOf("Find me data analyst internships in Chicago"), /\bdata analyst internships in chicago$/);
  assertNode.equal(searchTextOf("Find me 5 data analyst internships in Chicago that are actually open").role, "data analyst");
});

Deno.test("8 draft (unit): a draft to a named person is a draft; an ask with no message, or for a document, is not", () => {
  for (const m of ["draft a note to Priya Raman, a recruiter at Adobe, about the analyst opening. I'll send it myself.",
    "Keep it as a draft: write to Omar Haddad, an alum from TEST College who works at Intuit, asking for 20 minutes.",
    "Draft only: ask my friend Tess for a referral to Etsy, and say I can share my resume."]) assertNode.ok(namedDraftAsk(m), m);
  for (const m of ["Draft only: send it to Lena Kowalski.", "write my cover letter for the Adobe analyst role", "find data analyst roles at Adobe"]) assertNode.ok(!namedDraftAsk(m), m);
});

Deno.test({
  name: "1-10 through the real handler: each cause answers the task, plainly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: router mirror fixes handler part not run`); return; }
    let modelCalls = 0;
    const scripted = (chat: any) => {
      modelCalls++;
      return Response.json({ id: "rmf", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : MODEL_LINE }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(16, { model: (req) => anthropicWire(req, scripted) });
    try {
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const ask = async (m: string, o: { before?: string[]; resume?: boolean } = {}) => {
        const p = await w.person({ resume: o.resume });
        for (const b of o.before ?? []) await p.say(b);
        const calls = modelCalls;
        const r = await p.say(m);
        assertNode.equal(r.status, 200, m);
        return { ...r, reply: String(r.reply ?? ""), model: modelCalls > calls };
      };
      const NEVER = /not wired in this|this handler|runner/;

      // 1 + 2: the empty search names the role asked for, keeps the stated limits, and says it plainly.
      const e = await ask("Search only, nothing submitted: find biomedical engineer roles in Tulsa, posted in the last week, hybrid is fine.");
      assertNode.ok(!e.model, "a search is the router's");
      // Architect amendment (D-058, 2026-11-11, owner's "same length as Instinct"): the short empty-search form says the scope
      // and "no open roles" plainly; the refresh time, "Nothing was invented" and "nothing was applied for" are the turn's proof.
      assertNode.match(e.reply, /^I checked biomedical engineer in Tulsa on the live board and the saved job-board snapshot: no open roles\./, e.reply);
      const proof = (e as any).body?.meta?.search_proof;
      assertNode.match(String(proof?.result), /none was found, so I have no open roles to list/);
      assertNode.equal(proof?.invented, "Nothing was invented to fill the list.");
      assertNode.equal(proof?.applied, "Nothing was applied for.");
      assertNode.match(e.reply, /when it was posted/);
      assertNode.match(e.reply, /hybrid or office days/);
      assertNode.ok(!/nothing submitted|search only|posted in the last week in|hybrid is fine/i.test(e.reply.split(":")[0]), `the scope is the role and the place only: ${e.reply}`);
      assertNode.ok(!NEVER.test(e.reply), e.reply);
      // 1: an industry is not a place; "right now" is not part of one.
      const g = await ask("Do not apply on my behalf: game designer jobs in gaming.");
      assertNode.match(g.reply, /^I checked game designer in any location/, g.reply);
      const d = await ask("what forklift operator jobs are open in Fresno right now. Two things: posted this week, and evenings and weekends only. Don't apply to anything.");
      // 3: the person's own guard is not an ask to apply in bulk.
      assertNode.notEqual(d.intent, "intent_refusal", d.reply);
      assertNode.ok(!/Applying in bulk/.test(d.reply), d.reply);
      // Architect amendment (D-058): the short empty-search form (no comma before "on the live board").
      assertNode.match(d.reply, /^I checked forklift operator in Fresno on the live board/, d.reply);
      // 2: a short ask gets the short answer.
      const sh = await ask("find geologist roles in Reno, keep it short. Don't apply.");
      assertNode.match(sh.reply, /^I checked geologist in Reno on the live board/, sh.reply);
      assertNode.ok(prose(sh.reply).length <= 400, `${prose(sh.reply).length}: ${sh.reply}`);

      // 4: a question about what a pause would do pauses nothing; a pause still pauses.
      const h = await ask("If I said pause everything, what would happen to applications already in flight? Just explain, don't do it.");
      assertNode.ok(!/Done: your account is paused/.test(h.reply) && h.intent !== "career_paused", `${h.intent}: ${h.reply}`);
      const real = await ask("pause everything");
      assertNode.match(real.reply, /your account is paused/i, real.reply);

      // 5: a password or code in chat, and a CAPTCHA: a plain no first.
      const pw = await ask("here's my Greenhouse portal password TEST-not-real-pw-31, can you log in and finish it for me?");
      assertNode.match(pw.reply, /I won't use a code or password sent in chat, and I don't sign in for you\./, pw.reply);
      assertNode.ok(!/TEST-not-real-pw-31/.test(pw.reply));
      const cap = await ask("could you just solve the captcha on that application page for me?");
      assertNode.match(cap.reply, /^I won't solve a CAPTCHA/, cap.reply);

      // 6: a correction that names only the month it replaces is saved and said back.
      const gr = await ask("my graduation is December 2028, not May", { before: ["I graduate in May 2027."] });
      assertNode.ok(!/haven't changed your graduation date/.test(gr.reply), gr.reply);
      assertNode.match(gr.reply, /December 2028/, gr.reply);

      // 7: an ask for one employer's openings lists that employer's roles from the board, not its company file.
      const hi = await ask("find openings at Northline Health Data for data analyst interns, nothing submitted");
      assertNode.match(hi.reply, /Northline Health Data/, hi.reply);
      assertNode.ok(!/company file|the file holds|has no company file/i.test(hi.reply), hi.reply);
      assertNode.match(hi.reply, /Data Analyst Intern at Northline Health Data/, hi.reply);

      // 8: a draft to a named person is drafted (the brain's turn), not answered with a file, a list or "who?".
      for (const m of ["draft a referral request to Priya Raman. Say I can share my resume; nothing goes out.",
        "Keep it as a draft: write to Omar Haddad, an alum from TEST College who works at Intuit, asking for 20 minutes."]) {
        const r = await ask(m);
        assertNode.ok(r.model, `${m}: the brain drafts it (${r.intent}: ${r.reply.slice(0, 160)})`);
        assertNode.ok(!/no resume has been tailored|You have no contacts at|Which do you mean, and who should it go to/.test(r.reply), r.reply);
      }
      const amb = await ask("Draft only: send it to Lena Kowalski.", { resume: true });
      assertNode.ok(!amb.model, "with no message named, the router's question stands");

      // 9: the doorstep note is plain words, after the answer's first line.
      const ds = await ask("Don't submit: how should I answer the sponsorship question.", { resume: true, before: ["Find data analyst roles in Chicago. Don't apply to anything.", "Prepare the Lakefront one for review. Don't submit."] });
      assertNode.ok(!NEVER.test(ds.reply), ds.reply);
      assertNode.ok(!/^No employer form/.test(ds.reply), `the answer leads: ${ds.reply.slice(0, 200)}`);

      // 10: the practice question waits for an answer, as a question.
      const q = await ask("ask me one behavioral question and wait for my answer.");
      assertNode.match(q.reply, /^Here is your question: /, q.reply);
      assertNode.match(q.reply, /What is your answer\?/, q.reply);

      assertNode.deepStrictEqual(w.outbound, [], "no request left but the database double and the scripted model");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
