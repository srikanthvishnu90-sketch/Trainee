// R9-F follow-up (2026-11-08): employer research routing. The e2e full set (evals/career/e2e --set full, fake model) found
// research.employer at 23/50: "is <company> a good place to start? give me a file" and "investiga <company> como empleador ...
// y mándame un archivo" were claimed as document delivery and never researched. An employer as the subject of the ask
// ("what's X like to work for", "what is it like to work at X", "how is X as a place to work", "X as an employer") now goes to
// the research path with CAREER_RESEARCH_REPLY=on; "make me a file on <employer>" and the person's own papers stay documents.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { marketResearchAsk, researchAsk, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-re", threadId: "t-re", now: Date.UTC(2026, 10, 8, 15), snapshot: null, accountPersistence: true });
const ON = env({ CAREER_BRAIN: "staged", CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on" });
const decide = (e: ReturnType<typeof env>, m: string) => stagedDecision({ env: e, message: m, ctx: fresh(), host, structured: false });
const onOnly = env({ CAREER_RESEARCH_REPLY: "on" });

const EMPLOYER = [
  "what's Stripe like to work for?",
  "what is it like to work at Ramp",
  "whats Notion like to work for as a new grad",
  "how is Notion as a place to work",
  "how's Ramp to work for?",
  "how is Acme Energy as an employer for new grads? give me a file",
  "is Hollow Oak Logistics a good place to start? give me a file",
  "ngl is Upland Bio a good place to start? give me a file 🙌",
  "is Sable Bank a good employer for new grads",
  "reseaarch Lumina Systems as an employer for new grasd and send me a file",
  "hey can u research Fernhill Software as an employer for new grads and send me a file 🙌",
  "investiga Delta Bay Freight como empleador para recién graduados y mándame un archivo",
];
const DOCUMENTS = [
  "make me a file on Stripe",
  "send me my resume as a file",
  "is my resume a good fit for Stripe? send me the file",
  "give me a file of my cover letter",
];

Deno.test("employer research, file or not, goes to the staged brain's research path", () => {
  for (const m of EMPLOYER) {
    assertNode.ok(researchAsk(m), `a research ask: ${m}`);
    assertNode.ok(marketResearchAsk(onOnly, m, "career_document_delivery"), `passes over a document claim: ${m}`);
    const d = decide(ON, m);
    assertNode.equal(d.reason, "market_research", `${m} (${d.intent}, ${d.reason})`);
  }
});

Deno.test("a file on an employer, and the person's own papers, stay documents; the switch off changes nothing", () => {
  for (const m of DOCUMENTS) {
    assertNode.ok(!researchAsk(m), `not research: ${m}`);
    assertNode.ok(!marketResearchAsk(onOnly, m, "career_document_delivery"), m);
  }
  for (const m of EMPLOYER) assertNode.ok(!marketResearchAsk(env({ CAREER_RESEARCH_REPLY: "off" }), m, "career_document_delivery"), `off: ${m}`);
  assertNode.ok(!marketResearchAsk(onOnly, "is Stripe a good place to start? apply to all their roles", "career_batch_apply"), "an apply stays code's");
});
