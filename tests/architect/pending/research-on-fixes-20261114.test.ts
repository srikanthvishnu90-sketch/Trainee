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
