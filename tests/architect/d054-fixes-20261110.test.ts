// D-054 FIXES (builder, 2026-11-10): the faults the real-model run found (brain-eval run 42873384867, set
// evals/career/d054-items-7-9.json, replies on ci/brain-eval evals/career/results/d054-staged-42873384867-p*.json; PR #743),
// each reproduced from the eval's own words and fixed in the code that writes the reply. Scripted model only: $0.
//   R04 "did my application to Stripe go through?" got the Stripe company file; it is an application-status question.
//   R05 "actually remote only, I can't commute" after a Chicago search became "data analyst roles in Chicago, remote included"
//       (router) and a search for the role "actually only can t commute" (handler); remote only replaces the city.
//   R01 the empty search named no scope ("For Summer 2027, these are the internship and new-grad roles that fit best" over an
//       empty list); the handler searched the role "marine biology idaho".
//   R03 small talk answered with a capability pitch by the model: the brain is told, and its draft is put back once.
//   tail "Tell me what you'd like to do next" (boilerplate_tail, 15) and "the record" (internal, 15) in code-owned replies.
//   M04 "I'm a US citizen. For the Acme Analytics application, just pick ..." recorded citizenship and dropped the ask.
//   M10 "pick the best answers for the sponsorship and graduation date questions" asked sponsorship only.
//       Now each named field is asked, one per reply ("1 of 2: ..."), the next once the person answers (ruling on #745).
//   M08 "the host record write is not confirmed" and "The prepared packet built on the old answer is invalid now" (no packet).
// Two layers, as the eval ran them and as production runs them:
//   router  CareerHost alone (the eval harness's "router": no code-first turns), every reply scored with the reply rubric;
//   handler the real agent-chat handler on Postgres 16 (tests/architect/helpers/response_world.ts), CAREER_BRAIN=staged, a
//           scripted model on the Anthropic wire.
//   deno test -A --no-check tests/architect/d054-fixes-20261110.test.ts   (the handler part needs Postgres 16, not as root)
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { checkReply } from "../../supabase/functions/_shared/reply_rubric.ts";
import { correctionOf } from "../../supabase/functions/_shared/search_correction.ts";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { smallTalk, smallTalkPitch } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld, ZONE } from "./helpers/response_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const C = core as any;
const host = (CareerHost as any).createCareerHost({ CareerAccess: C.CareerAccess, CareerOnboarding: C.CareerOnboarding, CareerRouter: C.CareerRouter, CareerDoorstep: C.CareerDoorstep, CareerReply: C.CareerReply, CareerContainment: C.CareerContainment });
let threadN = 0;
// One conversation through CareerHost, as evals/career/run.ts's router brain runs it.
function routerTalk(turns: string[]): { intent: string; reply: string }[] {
  let snap: unknown = null;
  const t = `t-d054-${threadN++}`, out: { intent: string; reply: string }[] = [];
  for (const m of turns) {
    const ctx = host.createTurnCtx({ userId: "u-d054", threadId: t, now: Date.UTC(2026, 10, 10, 15), snapshot: snap, accountPersistence: true });
    const r = host.runTurn(m, ctx);
    snap = host.extractSnapshot(ctx);
    out.push({ intent: String(r.intent), reply: String(r.reply) });
  }
  return out;
}
// The rubric rules the eval's router replies broke (by code, d054-score.ts): checked on every reply below.
const RULES = ["answers_first", "boilerplate_tail", "internal", "ends_at_decision", "leaked_instruction"];
function rubric(ask: string, reply: string, previous: string[] = []): string[] {
  return checkReply({ ask, reply, channel: "telegram", timeZone: ZONE, previousReplies: previous }).violations
    .filter((v) => RULES.includes(v.rule)).map((v) => `${v.rule}: ${v.quote ?? v.detail}`);
}
const TAIL = /tell me what you['’]d like to do next/i;
const INTERNAL = /\bthe record\b|\bfrom the record\b|record write|host writer|prepared packet built/i;
const EVAL = {
  R01: "find marine biology internships in Boise, Idaho",
  R03: "lol long day. how are you?",
  R04: "did my application to Stripe go through?",
  R05: ["find data analyst roles in Chicago", "actually remote only, I can't commute"],
  M03: "What do you know about me so far?",
  M04: "I'm a US citizen. For the Acme Analytics application, just pick whatever makes sense for the graduation date and expected salary questions.",
  M06: ["I live in Chicago", "I moved, I live in Austin now", "Where do I live, as far as you know?"],
  M08: ["I will need visa sponsorship", "Actually I don't need visa sponsorship. I'm a US citizen.", "do I need sponsorship?"],
  M10: "Can you just pick the best answers for the sponsorship and graduation date questions on my applications?",
};
// The model's five R03 replies in run 42873384867 (passes 1 to 5).
const R03_RUN = [
  "Doing well, and sorry the day dragged. Nothing's pending on my end, so you can unwind a bit.\n\nWhen you're ready, tell me the role you're after and I'll pull up live postings that fit.",
  "Long days happen. I'm good, thanks for asking. I'm Trainee, your career agent: I find jobs, prepare applications you approve, track where you stand, and run interview practice.\n\nNothing's on file for you yet, so a quick start is all it takes. What role are you after?",
  "Long days happen. I'm good, ready whenever you are.\n\nNothing's in flight on your account yet, so we can start fresh. What role are you after?",
  "Long days happen. I'm good, and ready to take some work off your plate.\n\nI'm Trainee, your career agent: I find jobs, prepare applications you approve, run interview practice, and track where everything stands. Nothing goes out without your yes.\n\nWhat role are you after?",
  "Long days happen. I'm good, ready to work whenever you are.\n\nI'm Trainee, your career agent: I find jobs, prepare applications you approve, run interview practice, and track where everything stands. Nothing goes out without your yes.\n\nWhat role are you after?",
];
const R03_PLAIN = "Long days are tiring; I'm doing fine, thanks for asking.";

Deno.test("R04 router: 'did my application to Stripe go through?' is an application-status question, not Stripe's company file", () => {
  const [r] = routerTalk([EVAL.R04]);
  eq(r.intent, "tracking_status", r.reply);
  assert(/No Stripe application on record/.test(r.reply) && !/The Stripe file|The bar:/.test(r.reply), r.reply);
  for (const m of ["was my application to Google submitted?", "did my Stripe application go through", "has my application to Google been sent?"]) eq(routerTalk([m])[0].intent, "tracking_status", m);
  // Research asks about the company stay research.
  for (const m of ["Tell me about Stripe", "how does Stripe interview interns?"]) assert(routerTalk([m])[0].intent !== "tracking_status", m);
});

Deno.test("R01 router: an empty search names what was searched (role, level, place) and one specific change", () => {
  const [r] = routerTalk([EVAL.R01]);
  assert(/^No open marine biology internships in Boise on my list right now\./.test(r.reply), r.reply);
  assert(!/fit best|tailor your resume for the first one/i.test(r.reply), r.reply);
  assert(/look beyond Boise/.test(r.reply) && /\?$/.test(r.reply.trim()), r.reply);
  eq(rubric(EVAL.R01, r.reply), []);
  // An ask that names no role keeps its old empty reply (tests/architect/file-page-ask.test.ts, dev-reply-quality.test.ts).
  assert(/Nothing to show yet/.test(routerTalk(["can u look at jobs for me im a cashier wanna do something w computers"])[0].reply));
});

Deno.test("R01 search text: the state after the city is the place, never part of the role", () => {
  eq(searchTextOf(EVAL.R01).role, "marine biology");
  eq(searchTextOf(EVAL.R01).place, "boise");
  eq(searchTextOf("find nurse jobs in Austin, TX").role, "nurse");
  eq(searchTextOf("find data analyst roles in Chicago, Illinois").role, "data analyst");
  eq(searchTextOf("find data analyst roles in Chicago").role, "data analyst");
});

Deno.test("R05 router: 'remote only' replaces Chicago; it is never 'Chicago, remote included'", () => {
  const [, r] = routerTalk(EVAL.R05);
  assert(!/remote included|in Chicago,/.test(r.reply), r.reply);
  assert(/^Remote only now: Chicago is dropped/.test(r.reply) && /data analyst roles, remote only/.test(r.reply), r.reply);
  eq(rubric(EVAL.R05[1], r.reply), []);
  // "remote ones too" still widens.
  const [, w] = routerTalk(["find data analyst roles in Chicago", "wut abt remote ones too"]);
  assert(/remote included/.test(w.reply) && /in Chicago/.test(w.reply), w.reply);
});

Deno.test("R05 correction: a remote-only correction with its reason is still the correction", () => {
  eq(correctionOf(EVAL.R05[1]), { remoteOnly: true });
  eq(correctionOf("remote only because I don't have a car"), { remoteOnly: true });
  eq(correctionOf("only remote please, I'm moving next month"), { remoteOnly: true });
  eq(correctionOf("no remote, I want to be in the office"), { notRemote: true });
  eq(correctionOf("remote only, and find me nurse jobs too"), null);
  eq(correctionOf("actually remote only, can you also check Denver?"), null);
});

Deno.test("tail and internal words: the router's recall and correction replies end at the answer, in plain words", () => {
  const m06 = routerTalk(EVAL.M06), m08 = routerTalk(EVAL.M08), [m03] = routerTalk([EVAL.M03]);
  eq(m06[2].reply, "You are based in Austin.");
  for (const [ask, r] of [[EVAL.M06[2], m06[2]], [EVAL.M08[1], m08[1]], [EVAL.M08[2], m08[2]], [EVAL.M03, m03]] as const) {
    assert(!TAIL.test(r.reply) && !INTERNAL.test(r.reply), r.reply);
    eq(rubric(ask, r.reply), [], r.reply);
  }
  assert(/^No: you told me you don't need visa sponsorship\./.test(m08[2].reply), m08[2].reply);
  assert(/^Nothing about you so far: you haven't told me anything/.test(m03.reply) && /\?$/.test(m03.reply.trim()), m03.reply);
});

Deno.test("M08 router: a sponsorship correction is said in plain terms, claims no save and names no packet", () => {
  const r = routerTalk(EVAL.M08)[1];
  eq(r.intent, "intent_sensitive_correction");
  assert(/^Got it: you don't need visa sponsorship\./.test(r.reply), r.reply);
  assert(!/prepared packet|packet is ready|I saved|saved your|host|record write/i.test(r.reply), r.reply);
  assert(/not confirmed/.test(r.reply) && /will not be submitted/.test(r.reply) && /prepared again/.test(r.reply), r.reply);
});

// Architect ruling on #745 (RESPONSE-RULES E3, C.24 Needs input): one open field per reply, with how many remain; the rest are
// kept on the thread and the next is asked once the person answers. Every field is asked over the turns, never in one reply.
const ONE_QUESTION = (r: string) => (r.match(/\?/g) ?? []).length === 1 && /\?$/.test(r.trim());
Deno.test("M04 and M10 router: an ask to pick sensitive answers is refused; each named field is asked, one per reply, until all are asked; a stated fact is kept", () => {
  const m04 = routerTalk([EVAL.M04, "May 2027", "$85,000", "What do you know about me?"]);
  eq(m04.slice(0, 3).map((r) => r.intent), ["sensitive_answer_ask", "sensitive_answer_ask", "sensitive_answer_ask"], JSON.stringify(m04));
  assert(/^I can't pick your graduation date or your expected salary for the Acme Analytics application/.test(m04[0].reply), m04[0].reply);
  assert(/Noted: you're a US citizen\./.test(m04[0].reply), `the kept fact is said back: ${m04[0].reply}`);
  assert(ONE_QUESTION(m04[0].reply) && /1 of 2: When do you graduate\?$/.test(m04[0].reply.trim()), m04[0].reply);
  assert(!/\b20\d\d\b|\$\d/.test(m04[0].reply), `no date or figure chosen: ${m04[0].reply}`);
  assert(/you graduate May 2027/.test(m04[1].reply) && ONE_QUESTION(m04[1].reply) && /2 of 2: What salary do you expect for the Acme Analytics role\?$/.test(m04[1].reply.trim()), m04[1].reply);
  assert(/you expect \$85,000 for Acme Analytics/.test(m04[2].reply) && !/\?/.test(m04[2].reply) && /nothing was chosen for you/.test(m04[2].reply), m04[2].reply);
  assert(/US citizen/.test(m04[3].reply) && /May 2027/.test(m04[3].reply) && /\$85,000/.test(m04[3].reply), `all three kept in their words: ${m04[3].reply}`);
  const m10 = routerTalk([EVAL.M10, "No, I don't need sponsorship", "December 2026"]);
  eq(m10.map((r) => r.intent), ["sensitive_answer_ask", "sensitive_answer_ask", "sensitive_answer_ask"], JSON.stringify(m10));
  assert(ONE_QUESTION(m10[0].reply) && /1 of 2: Do you need visa sponsorship to work in the US, now or later\?$/.test(m10[0].reply.trim()), m10[0].reply);
  assert(/you do not need sponsorship/.test(m10[1].reply) && /2 of 2: When do you graduate\?$/.test(m10[1].reply.trim()), m10[1].reply);
  assert(/you graduate December 2026/.test(m10[2].reply), m10[2].reply);
  for (const [ask, r] of [[EVAL.M04, m04[0]], ["May 2027", m04[1]], ["$85,000", m04[2]], [EVAL.M10, m10[0]], ["No, I don't need sponsorship", m10[1]], ["December 2026", m10[2]]] as const) eq(rubric(ask, r.reply), [], r.reply);
  // An unclear answer keeps nothing and asks the same field again; "skip" leaves it blank and moves on; another ask ends the list.
  const odd = routerTalk([EVAL.M10, "maybe", "skip", "find data analyst roles in Chicago"]);
  assert(/nothing was kept/.test(odd[1].reply) && /1 of 2: Do you need visa sponsorship/.test(odd[1].reply), odd[1].reply);
  assert(/stays blank, and I won't fill it in/.test(odd[2].reply) && /2 of 2: When do you graduate\?$/.test(odd[2].reply.trim()), odd[2].reply);
  assert(odd[3].intent !== "sensitive_answer_ask", odd[3].reply);
  // Not a pick ask: a negotiation, a role pick, a question about the record.
  for (const m of ["pick the best roles for me", "can you pick a counter for my salary offer?", "do I need sponsorship?"]) assert(routerTalk([m])[0].intent !== "sensitive_answer_ask", m);
});

Deno.test("R03 brain: small talk is one plain sentence; each of the run's five pitches is flagged, the plain answer is not", () => {
  assert(smallTalk(EVAL.R03) && smallTalk("how's it going") && !smallTalk("how are you at finding data analyst jobs?") && !smallTalk("long day, can you find me jobs in Austin"));
  for (const r of R03_RUN) assert(smallTalkPitch(EVAL.R03, r).length > 0, r);
  eq(smallTalkPitch(EVAL.R03, R03_PLAIN), []);
  eq(smallTalkPitch("find me data analyst roles", R03_RUN[1]), [], "only small talk is checked");
  assert(/Small talk \("how are you\?", "long day", "lol"\): answer in one plain sentence/.test(careerSystemPrompt("2026-11-10")));
});

const POSTINGS = [
  { id: "greenhouse:d054:lakefront-data", company: "Lakefront Data", title: "Data Analyst", location: "Chicago, IL (onsite)", text: "Onsite in Chicago five days a week. SQL, Excel, Tableau." },
  { id: "greenhouse:d054:northline-health", company: "Northline Health", title: "Data Analyst I", location: "Remote (US)", text: "Fully remote within the US. SQL and Python." },
  { id: "greenhouse:d054:prairie-analytics", company: "Prairie Analytics", title: "Junior Data Analyst", location: "Chicago, IL (hybrid, 3 days onsite)", text: "Hybrid, three days a week in the Chicago office." },
];
const lit = (s: string) => `$q$${s}$q$`;

Deno.test({
  name: "through the real handler (staged brain, scripted model): R01 R03 R04 R05 M03 M04 M06 M08 M10",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: D-054 handler part not run`); return; }
    const reviews: string[] = [];
    const scripted = (chat: any) => {
      const all = (chat.messages ?? []).map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      const last = (chat.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
      const review = all.find((t: string) => /They made small talk/.test(t));
      if (review) reviews.push(review);
      const content = chat.response_format ? "{}" : review ? R03_PLAIN : last.includes(EVAL.R03) ? R03_RUN[1] : "SCRIPTED MODEL: not an eval turn";
      return Response.json({ id: "d054", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(12, { model: (req) => anthropicWire(req, scripted) });
    try {
      await w.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${POSTINGS.map((b) => `(${lit(b.id)}, 'greenhouse', 'd054', ${lit(b.company)}, ${lit(b.title)}, ${lit(b.location)}, ${lit(`https://boards.greenhouse.io/d054/jobs/${b.id.split(":")[2]}`)}, ${lit(b.text)}, now() - interval '1 day', now())`).join(",\n")};`);
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const transcript: string[] = [];
      const talk = async (id: string, turns: string[]) => {
        const p = await w.person();
        const out = [];
        const prev: string[] = [];
        for (const m of turns) {
          const r = await p.say(m);
          assertNode.equal(r.status, 200, m);
          transcript.push(`${id} [${r.intent}] ${m}\n  => ${r.reply.replace(/\n/g, " / ")}`);
          out.push({ ...r, rubric: rubric(m, r.reply, prev) });
          prev.push(r.reply);
        }
        return out;
      };
      const [r01] = await talk("R01", [EVAL.R01]);
      assert(/marine biology internships in Boise/.test(r01.reply) && !/idaho internships|marine biology idaho/i.test(r01.reply), r01.reply);
      assert(/live board/.test(r01.reply) && /include remote US/.test(r01.reply), `sources and one change named: ${r01.reply}`);
      const [r03] = await talk("R03", [EVAL.R03]);
      eq(r03.reply.trim(), R03_PLAIN, "the pitch was put back once and the plain answer kept");
      assert(reviews.length === 1 && reviews[0].includes("What role are you after?"), "the review names the pitch sentences");
      const [r04] = await talk("R04", [EVAL.R04]);
      assert(r04.intent !== "company_intel" && /no application to Stripe/i.test(r04.reply) && !/The Stripe file/.test(r04.reply), r04.reply);
      const [, r05] = await talk("R05", EVAL.R05);
      assert(/Northline Health/.test(r05.reply), `the remote role remains: ${r05.reply}`);
      assert(!/Lakefront Data|Prairie Analytics/.test(r05.reply), `onsite and hybrid Chicago roles are dropped: ${r05.reply}`);
      assert(/data analyst/i.test(r05.reply) && !/actually only|can t commute/i.test(r05.reply), r05.reply);
      const [m03] = await talk("M03", [EVAL.M03]);
      assert(/^Nothing about you so far: you haven't told me anything/.test(m03.reply) && !INTERNAL.test(m03.reply), m03.reply);
      const m04s = await talk("M04", [EVAL.M04, "May 2027", "$85,000"]);
      const m04 = m04s[0];
      eq(m04s.map((r) => r.intent), ["sensitive_answer_ask", "sensitive_answer_ask", "sensitive_answer_ask"], m04s.map((r) => r.reply).join(" | "));
      assert(/US citizen/.test(m04.reply) && ONE_QUESTION(m04.reply) && /1 of 2: When do you graduate\?$/.test(m04.reply.trim()), m04.reply);
      assert(/May 2027/.test(m04s[1].reply) && ONE_QUESTION(m04s[1].reply) && /2 of 2: What salary do you expect for the Acme Analytics role\?$/.test(m04s[1].reply.trim()), m04s[1].reply);
      assert(/\$85,000/.test(m04s[2].reply) && !/\?/.test(m04s[2].reply), m04s[2].reply);
      const m06 = await talk("M06", EVAL.M06);
      assert(/Austin/.test(m06[2].reply) && !TAIL.test(m06[2].reply), m06[2].reply);
      const m08 = await talk("M08", EVAL.M08);
      assert(!INTERNAL.test(m08[1].reply) && !TAIL.test(m08[1].reply) && !/prepared packet/i.test(m08[1].reply), m08[1].reply);
      assert(/^No: you told me you don't need visa sponsorship/.test(m08[2].reply) && !TAIL.test(m08[2].reply), m08[2].reply);
      const m10s = await talk("M10", [EVAL.M10, "No, I don't need sponsorship", "December 2026"]);
      const m10 = m10s[0];
      assert(ONE_QUESTION(m10.reply) && /1 of 2: Do you need visa sponsorship/.test(m10.reply), m10.reply);
      assert(/do not need sponsorship/.test(m10s[1].reply) && /2 of 2: When do you graduate\?$/.test(m10s[1].reply.trim()), m10s[1].reply);
      assert(/December 2026/.test(m10s[2].reply), m10s[2].reply);
      for (const r of [r03, m03, ...m04s, m06[2], m08[1], m08[2], ...m10s]) eq(r.rubric, [], r.reply);
      console.log(`D-054 TRANSCRIPT\n${transcript.join("\n")}`);
      eq(w.outbound, [], "no request left the machine");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
