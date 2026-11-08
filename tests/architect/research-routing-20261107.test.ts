// R9-F (2026-11-07): research routing. The end-to-end eval (evals/career/e2e, research area, 0/10 on trunk) found research asks
// that end in "give me a file" claimed by the router as a document delivery ("there is no document file on this conversation
// yet") and never researched. With CAREER_RESEARCH_REPLY=on these asks now go to the staged brain (reason "market_research"),
// which has research_market and the research brief File; the person's own papers ("send me my resume as a file") stay on the
// document path, a job search stays a search, and with the switch off nothing changes.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { marketResearchAsk, researchAsk, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-rr", threadId: "t-rr", now: Date.UTC(2026, 10, 7, 15), snapshot: null, accountPersistence: true });
const ON = env({ CAREER_BRAIN: "staged", CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on" });
const OFF = env({ CAREER_BRAIN: "staged" });
const decide = (e: ReturnType<typeof env>, m: string) => stagedDecision({ env: e, message: m, ctx: fresh(), host, structured: false });

// The research area of evals/career/e2e/tasks.json (E21-E30, last turn of each) and the asks the work order names.
const RESEARCH = [
  "research the data analyst job market in Chicago and give me a file",
  "research Stripe as an employer for new grads and send me a file",
  "research this market: new grad backend roles in Austin. give me a file with the numbers",
  "what do entry-level financial analysts earn in New York? put it in a file with sources",
  "research Ramp's growth and hiring and give me a file",
  "research the frontend internship market in Chicago and give me a file",
  "compare Stripe and Ramp as places to start my career and give me a file",
  "now research those companies and give me a file",
  "research how big the data science intern market is in Chicago and give me a file",
  "research investment banking summer analyst programs in New York and give me a file",
  "make me a brief on the EV charger market",
  "write me a report about fintech hiring in New York",
  "compare Acme and Globex",
  "what would change the market for home batteries? give me a file",
];
const DOCUMENTS = [
  "send me my resume as a file",
  "send me my tailored resume as a pdf",
  "give me a file of my cover letter",
  "can you send the document again",
  "compare my resume with this posting",
  "give me a report of my applications",
];

Deno.test("research asks, file or not, go to the staged brain's research path", () => {
  for (const m of RESEARCH) {
    assertNode.ok(researchAsk(m), `a research ask: ${m}`);
    const d = decide(ON, m);
    assertNode.equal(d.brain, true, `to the brain: ${m} (${d.intent}, ${d.reason})`);
    assertNode.equal(d.reason, "market_research", `${m} (${d.intent})`);
  }
});

Deno.test("a research ask passes over a document-delivery claim; the person's own papers do not", () => {
  const on = env({ CAREER_RESEARCH_REPLY: "on" });
  for (const m of RESEARCH) assertNode.ok(marketResearchAsk(on, m, "career_document_delivery"), m);
  for (const m of DOCUMENTS) {
    assertNode.ok(!researchAsk(m), `not research: ${m}`);
    assertNode.ok(!marketResearchAsk(on, m, "career_document_delivery"), m);
    assertNode.notEqual(decide(ON, m).reason, "market_research", m);
  }
  // Other code-owned work stays code's even when the words sound like research.
  assertNode.ok(!marketResearchAsk(on, "research these 3 companies and apply to all", "career_batch_apply"));
  assertNode.ok(!marketResearchAsk(on, "find data analyst roles in Chicago and research the market", "career_discovery"), "a job search stays a search");
});

Deno.test("CAREER_RESEARCH_REPLY off: routing is as before", () => {
  for (const m of RESEARCH) {
    assertNode.ok(!marketResearchAsk(env({}), m, "career_document_delivery"), m);
    assertNode.notEqual(decide(OFF, m).reason, "market_research", m);
  }
});
