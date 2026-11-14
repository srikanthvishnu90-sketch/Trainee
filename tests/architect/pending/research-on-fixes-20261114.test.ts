// Product fixes found while amending the tests for the research support check switched on (owner decision 2026-11-13), group B's
// report: $0, flag on, no network. Red on origin/ag/research-support-on (b0610b78c), green here.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { researchCompany } from "../../../supabase/functions/_shared/agent/research/company.ts";
import { stripUrls } from "../../../supabase/functions/_shared/agent/research/reply.ts";
import { decide, indexPages, type SupportJudge } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { NOW, world as world0 } from "../../helpers/research_company_web.ts";
import { supportsClaim, testSupportJudge } from "../support-test-judge.ts";

FAIL_CLOSED.support = true;
const world = () => { const w = world0(); w.deps = { ...w.deps, judge: testSupportJudge }; return w; };
const T1 = "I have an interview at Stripe next week. Help me prepare.";
const plan = { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] };

Deno.test("fix 1: a link at a sentence's end keeps the sentence's full stop when it is taken out", () => {
  eq(stripUrls("I put it in the file https://evil.example/x. What role are you interviewing for?"), "I put it in the file. What role are you interviewing for?");
  eq(stripUrls("See www.evil.example/a, then reply."), "See, then reply.");
  eq(stripUrls("Read [the page](https://evil.example/x). Then ask."), "Read the page. Then ask.");
  eq(stripUrls("Visit https://evil.example/x"), "Visit");
});

Deno.test("fix 2 and 3: developments are one line per page unit; questions, unknowns and the labelled reading are kept, unjudged, under their own code checks", async () => {
  const w = world();
  const r: any = await researchCompany({ company: "Stripe", role: "Data analyst internship", question: T1, plan, deps: w.deps, now: NOW });
  eq(r.status, "ok");
  const texts = r.developments.map((d: any) => d.text);
  eq(texts.length, new Set(texts).size, "no development twice");
  eq(texts.length, 2);
  ok(r.questions.length >= 1 && r.questions.every((q: any) => /^Your team is working on .+\. How do you decide between .+ and .+\?$/.test(q.text)), JSON.stringify(r.questions));
  ok(r.unknowns.length >= 1, "the model's unknowns are shown");
  ok(r.frame && /payments plus software/.test(r.frame.text), "Trainee's labelled reading is shown");
  // Still never an unchecked figure or an invented initiative (each keeps its own code check).
  ok(!/crypto|3%|acceptance rate|revenue was|reached a \$1 billion/i.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 400));
  // focus "questions" for the hiring manager: the questions are built, so the File has its section.
  const r3: any = await researchCompany({ company: "Stripe", role: "Data analyst internship", question: "more questions for the hiring manager", focus: "questions", audience: "hiring manager", plan, deps: w.deps, now: NOW } as any);
  eq(r3.status, "ok");
  ok(r3.questions.length >= 2, JSON.stringify(r3.questions));
});

Deno.test("fix 3: \"none stated anything the brief could quote\" is said only when drafted lines were judged and refused", async () => {
  const empty = world(); empty.deps = { ...empty.deps, draft: async () => "{}" };
  const a: any = await researchCompany({ company: "Stripe", question: T1, plan, deps: empty.deps, now: NOW, focus: "competitors" } as any);
  if (a.status === "no_sources") ok(!/none stated anything the brief could quote/.test(a.blocker), a.blocker);
  const no = world(); no.deps = { ...no.deps, judge: async (cs) => cs.map(() => "no" as const), draft: async () => JSON.stringify({ competitors: [{ name: "Adyen", text: "Adyen competes with Stripe.", quote: "Adyen", url: "https://stripe.example/" }] }) };
  const b: any = await researchCompany({ company: "Stripe", question: T1, plan, deps: no.deps, now: NOW, focus: "competitors" } as any);
  if (b.status === "no_sources") ok(/none stated anything the brief could quote/.test(b.blocker), b.blocker);
  ok(a.status === "no_sources" || b.status === "no_sources", "at least one case reaches the blocker");
});

Deno.test("fix 4: the unit the draft cited is tried first; when the claim is refused, that unit (not the header) is offered as the quote", async () => {
  const page = "Posting on Zentrafin's Greenhouse job board (token zentrafin): Data Analyst Intern, Chicago, IL. The posting says: You will build dashboards for the payments team and define metrics for checkout conversion.";
  const idx = indexPages([{ text: page, title: "Data Analyst Intern", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true" }], undefined, ["Zentrafin"], { ask: "what does a data analyst intern do" });
  const seen: string[] = [];
  const judge: SupportJudge = async (cs) => cs.map((c) => { seen.push(c.source); return /^The marked text "The posting says/.test(c.claim) ? "yes" : "no"; });
  const [v] = await decide([{ claim: "The Data Analyst Intern will build dashboards for the payments team.", pages: [0], fallback: "You will build dashboards for the payments team" }], idx, judge);
  eq(v.how, "quote");
  ok(v.how === "quote" && /^The posting says: You will build dashboards/.test(v.sentence), JSON.stringify(v));
});

Deno.test("the shared test judge refuses a forecast stated as a result, and a result stated as a forecast", () => {
  const src = (t: string) => `Page title: Stripe\nWhole page, the candidate marked:\n>>> ${t} <<<`;
  ok(!supportsClaim("The Revenue suite reached a $1 billion annual run rate in 2026.", src("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.")));
  ok(!supportsClaim("The Revenue suite will reach a $1 billion annual run rate.", src("The Revenue suite reached a $1 billion annual run rate.")));
  ok(supportsClaim("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.", src("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.")));
});

// ---- fixes 5 to 11 (groups A and C)
import { quotable } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { readableText } from "../../../supabase/functions/_shared/research_sources.ts";
import { turnLines } from "../../../supabase/functions/_shared/agent/loop.ts";
Deno.test("fix 5: \"installed\" in a fact is not a software install; an install order still is", () => {
  ok(quotable("Acme Energy installed 41,000 home batteries in 2025."));
  ok(quotable("Globex Power has installed solar panels on 9,000 homes."));
  for (const u of ["Citadel interns must install the RemoteDesk tool on a personal laptop.", "Candidates install our screening app before the call.", "Download the installer to continue your application."]) ok(!quotable(u), u);
});
Deno.test("fix 7: a page's title ends its own line, so it is never glued onto the first sentence", () => {
  const { title, text } = readableText("<html><head><title>Careers at Zentrafin</title></head><body><p>Zentrafin hires new grads into engineering.</p></body></html>");
  eq(title, "Careers at Zentrafin");
  ok(text.split("\n").some((l) => l.trim() === "Zentrafin hires new grads into engineering."), JSON.stringify(text));
});
Deno.test("fixes 9 and 11: code's own lines (a closed posting's note, the read-only boundary) and a posting's read lines are reported for the support check", () => {
  const seen = [JSON.stringify({ company: "Stripe", title: "Data Analyst Intern", closed: true, closed_on: "2026-09-15" }),
    JSON.stringify({ board: "Workday", boundary: "Read only: no account, saved application or submission was created.", sign_in_required: true, requirements: { required: ["MS/PhD in Computer Science"], preferred: ["CUDA"] } }), "not json"];
  const { codeLines, readLines } = turnLines(seen);
  ok(codeLines.includes("Note: the Data Analyst Intern posting at Stripe closed on 2026-09-15; it no longer takes applications."), JSON.stringify(codeLines));
  ok(codeLines.includes("Read only: no account, saved application or submission was created."));
  ok(readLines.includes("MS/PhD in Computer Science") && readLines.includes("CUDA") && readLines.some((l) => /questions are behind that sign-in/.test(l)), JSON.stringify(readLines));
  eq(turnLines([JSON.stringify({ company: "Stripe", closed: false })]), { codeLines: [], readLines: [] });
});

// ---- architect ruling 2026-11-14 (narrowed on review of 7487f3600): advice outside the page judge stands on the CONFIRMED record
// alone: no employer or company, no figure or name from what the person says they heard, from their unconfirmed words or from a page
import { adviceOfTheirOwn, keepSupported } from "../../../supabase/functions/_shared/agent/research/support.ts";
const CONFIRMED = ["Lakeshore University, BS Computer Science and Finance, Expected June 2029", "Skill: Python", "Skill: React", "Pixelforge, Founder (2023-2025): hand-coded 70+ React websites for clients."];
Deno.test("ruling 1: an advice sentence on the confirmed record alone stands unjudged", async () => {
  const own = adviceOfTheirOwn(CONFIRMED);
  const good = "Your education line is Lakeshore University, BS Computer Science and Finance, Expected June 2029, and your skills line leads with Python and React.";
  ok(own(good));
  const no: SupportJudge = async (cs) => cs.map(() => "no" as const);
  const k = await keepSupported(`${good} Citadel pays interns $10k a week, which is the top of the market.`, [{ text: "Start with your name and contact links.", title: "Guide" }], { judge: no, advice: own });
  ok(k.text.includes(good) && !/Citadel|10k/.test(k.text), k.text);
});
Deno.test("ruling 1: the review's repros and four variants are judged, never kept unjudged", () => {
  const own = adviceOfTheirOwn(CONFIRMED);
  for (const bad of [
    "Citadel pays interns $10k a week, which is the top of the market.",   // the person said "I heard Citadel pays $10k a week."
    "Goldman Sachs pays $120 an hour to interns.",                          // "My internship pays $120 an hour."; the name from the guide
    "Your Pixelforge work earned $9k a month, so lead with it.",            // an organisation of the record, with a figure it does not hold
    "Pixelforge is a fast-growing studio, so lead with it.",                // an organisation of the record, with a claim about it
    "Put your photo and date of birth at the top.",                         // general advice, nothing of the record
    "Recruiters reject two-page resumes outright.",                         // a claim about the world
    "List TypeScript and SQL after Python.",                                // names the person never confirmed
    "Your 3.9 GPA from Lakeshore University belongs on top.",               // a figure the person never confirmed
  ]) ok(!own(bad), bad);
});

// Turn-level (the entry point every version exposes): the review's two leaks and four variants through agentTurn's advice path,
// with a judge that says no. Red on 7487f3600 (each sentence was kept unjudged), green here.
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
const aSay = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const aUse = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
const GUIDE_URL = "https://careers.stateuniversity.edu/resume";
const guideSearch = async () => ({ status: "ok", facts: [{ id: "", kind: "program", text: "Goldman Sachs and other banks read the top third of a resume first; keep it to one page.", quote: "Goldman Sachs and other banks read the top third of a resume first; keep it to one page.", url: GUIDE_URL, label: "State University career center" }], urls: [GUIDE_URL], cost_usd: 0.01 });
const FACTS = [{ id: "F-1", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" }, { id: "F-2", kind: "skill", text: "Skill: SQL", name: "SQL", status: "confirmed", unproven: true }];
const adviceTurn = (history: { role: string; content: string }[], reply: string) => agentTurn({ message: "what goes at the top of my resume?", history, stores: { profile: { facts: structuredClone(FACTS) } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"), knowledge: true,
  market: { judge: async (cs: any[]) => cs.map(() => "no") }, model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("research_career_question", { question: "what goes at the top of my resume?", kind: "advice", query: "resume top" }), aSay(reply)][Math.min(n++, 1)] : aSay(""); })(), research: { search: guideSearch } } as any) as Promise<any>;
Deno.test("ruling 1 at the turn: what the person heard, their unconfirmed words and the guide's names never ride the advice exemption", async () => {
  const cases: [string, { role: string; content: string }[], string, RegExp][] = [
    ["repro 1: heard", [{ role: "user", content: "I heard Citadel pays $10k a week." }], "Citadel pays interns $10k a week, which is the top of the market.", /Citadel|10k/],
    ["repro 2: guide name", [{ role: "user", content: "My internship pays $120 an hour." }], "Goldman Sachs pays $120 an hour to interns.", /Goldman|120/],
    ["variant: their unconfirmed figure", [{ role: "user", content: "My GPA is 3.4." }], "Put your 3.4 GPA next to Lakeshore University.", /3\.4/],
    ["variant: an employer they named", [{ role: "user", content: "I interned at Stripe last summer." }], "Lead with your Stripe internship under Lakeshore University.", /Stripe/],
    ["variant: a market claim", [], "SQL is the most requested skill at every bank this year.", /most requested/],
    ["variant: a guide figure", [], "Banks read the top 3 inches of a resume for SQL.", /3 inches/],
  ];
  for (const [name, history, reply, bad] of cases) {
    const t = await adviceTurn(history, reply);
    ok(!bad.test(t.reply), `${name}: ${t.reply}`);
  }
  // On the confirmed record alone the advice stands (a confirmed skill not yet in a bullet included).
  const good = "Under Lakeshore University, BS Computer Science and Finance, Expected June 2029, list SQL.";
  ok((await adviceTurn([], good)).reply.includes(good));
});
