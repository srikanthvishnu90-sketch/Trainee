// D-047 (architect ruling 2026-11-09, on the owner's order that research work in production): CAREER_RESEARCH_REPLY is served on.
// With the release value (the key unset, as production leaves it), beta case C11 (a comparison of two career paths that asks to
// separate general guidance from what needs current research) goes to the research path; with the rollback ("off") it keeps the
// pre-D-047 route (tests/architect/brain-decides-questions.test.ts BDQ-2). The research brief File stays off.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { researchBriefOn, researchReplyOn } from "../../supabase/functions/_shared/research_reply.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-d047", threadId: "t-d047", now: Date.UTC(2026, 10, 9, 15), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const C11 = "Read-only beta test C11. Compare software QA analyst and IT help desk as entry-level career paths in general, not for my personal profile. Explain day-to-day work, transferable skills, training needed and tradeoffs. Separate general guidance from anything needing current local research. Do not claim current openings or salaries without sources. No profile changes, reminders, outreach or applications.";

Deno.test("D-047: with the release value, the C11 comparison goes to market_research; the rollback keeps the old route", () => {
  const served = env({ CAREER_BRAIN: "staged" }), rolledBack = env({ CAREER_BRAIN: "staged", CAREER_RESEARCH_REPLY: "off" });
  eq([researchReplyOn(served), researchReplyOn(rolledBack)], [true, false]);
  const on = stagedDecision({ env: served, message: C11, ctx: fresh(), host, structured: false });
  eq([on.brain, on.reason], [true, "market_research"]);
  const off = stagedDecision({ env: rolledBack, message: C11, ctx: fresh(), host, structured: false });
  eq([off.brain, off.intent], [true, "career_recommendations"]);
  eq(researchBriefOn(served), false, "the research brief File stays off");
});
