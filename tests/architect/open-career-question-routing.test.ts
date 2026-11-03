// An open "how do I get hired as X / break into X" question goes to the brain (research_career_question), never to the library
// definition (role_kb_stats) or the generic path list, from any stage; company-specific asks and posting-requirement asks stay code's.
//   deno test -A --no-check tests/architect/open-career-question-routing.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-oq", threadId: "t-oq", now: Date.UTC(2026, 9, 29, 15), snapshot: null, accountPersistence: true });
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const ON = env({ CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on" });
const decide = (m: string, e = ON) => stagedDecision({ env: e, message: m, ctx: fresh(), host, structured: false });

const OPEN = [
  "I'm a freshman in college. How do I get hired as an investment banker?",
  "how do I get hired as a nurse?",
  "how do I become a data analyst?",
  "how do I break into investment banking?",
  "I'm a sophomore, how do I break into consulting?",
  "I'm 40 and want a new career. How do I get hired as an electrician?",
];
Deno.test("OQ-1 open entry questions go to the brain with CAREER_BRAIN=staged and CAREER_KNOWLEDGE=on", () => {
  for (const m of OPEN) { const d = decide(m); assertNode.deepStrictEqual([d.brain, d.reason], [true, "open_career_question"], `${m}: ${d.reason}`); }
});
Deno.test("OQ-2 without CAREER_KNOWLEDGE=on (no research tool) the library answer stays: nothing unsourced from the model", () => {
  for (const m of OPEN) assertNode.equal(decide(m, env({ CAREER_BRAIN: "staged" })).reason === "open_career_question", false, m);
  assertNode.equal(decide(OPEN[0], env({ CAREER_BRAIN: "staged" })).reason, "code_product");
  assertNode.equal(decide(OPEN[0], env({ CAREER_BRAIN: "router", CAREER_KNOWLEDGE: "on" })).brain, false, "router mode (the D-035 rollback): never");
});
Deno.test("OQ-3 company-specific and posting-requirement asks stay on the library / code", () => {
  for (const m of ["what does Stripe look for in software engineers?", "what do data analyst postings usually require?", "how do I get hired at Goldman Sachs as an analyst?", "find me data analyst jobs in Chicago", "apply to the Backend Software Engineer role at Ironstack Payments"]) {
    const d = decide(m); assertNode.notEqual(d.reason, "open_career_question", m); assertNode.equal(d.brain, false, `${m}: ${d.reason}`);
  }
});
Deno.test("OQ-4 the research tool is the brain's for it: present only with research deps, named in the tool description", () => {
  const t = (careerTools as any)({ postings: async () => [], research: { search: async () => ({ status: "error", detail: "x" }) } }).find((x: any) => x.name === "research_career_question");
  assertNode.ok(t && /how do I get hired as an investment banker/.test(t.description));
  assertNode.ok(!(careerTools as any)({ postings: async () => [] }).some((x: any) => x.name === "research_career_question"));
});
