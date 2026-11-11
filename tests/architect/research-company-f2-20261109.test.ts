// deno-lint-ignore-file no-explicit-any require-await
// R10 WO-H, spec F.2 (the owner's production turns, 2026-11-08 6:03-6:04 pm CST, on 7d2e8ee1): company research was routed into
// applications (BATCH_NOT_STARTED_REPLY), then the correction into a people list ("Building the list now: 5 analysts at Stripe").
// Both exact turns are replayed here. With research on they reach company research and get a sourced chat answer (sourced
// sentences, labelled interpretation, grounded questions, what the sources cannot establish, numbered sources); with research off,
// or when no source can be read, the reply names the specific blocker. Never applications, introductions or outreach. Scripted
// model, synthetic web: $0, no network. Every test here fails on trunk.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { researchOverAction, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { RESEARCH_OFF_REPLY } from "../../supabase/functions/agent-chat/handler-career.ts";
import type { MarketDeps } from "../../supabase/functions/_shared/agent/research/market.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { ALL, companyWeb, NOW, PUBLIC, U, world } from "../helpers/research_company_web.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const F2A = "Let's leave the job search for now. What's Stripe like to work for as a data analyst intern? Give me a useful company research answer: what its business does, what an analyst might work on, any concerns to investigate, and 5 good questions to ask in an interview. Use real sources and distinguish facts from your interpretation. Don't apply or contact anyone.";
const F2B = "I'm not asking for an application batch. I only want company research about Stripe. Please answer in chat: what Stripe does, what data analysts work on, 5 interview questions, and source links. If you can't research it, name the specific blocker instead of explaining how to apply.";

const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-f2", threadId: "t-f2", now: NOW, snapshot: null, accountPersistence: true });
const ACTIONS = /\b(?:apply list|application batch|batch|building the list|analysts at stripe|intro(?:duction)?s? drafted|outreach|runner)\b/i;

Deno.test("F.2 routing: both exact turns reach company research (never the batch or the people list)", () => {
  const on = env({ CAREER_BRAIN: "staged", CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on" });
  for (const m of [F2A, F2B]) {
    const d = stagedDecision({ env: on, message: m, ctx: fresh(), host, structured: false });
    eq([d.brain, d.reason], [true, "company_research"], m.slice(0, 40));
    ok(researchOverAction(m));
  }
  // Without the boundary or the research ask, nothing changes: an apply or a people list stays the person's own ask.
  for (const m of ["apply to 5 data analyst intern jobs at Stripe", "find 5 analysts at Stripe I could contact", "research Stripe and then apply to their analyst intern role"]) ok(!researchOverAction(m), m);
});

Deno.test("F.2 research off: the reply names the specific blocker, and nothing is applied for or contacted", () => {
  ok(/switched off/.test(RESEARCH_OFF_REPLY) && /Nothing was applied for and no one was contacted/.test(RESEARCH_OFF_REPLY));
  ok(!ACTIONS.test(RESEARCH_OFF_REPLY) && !/apply to the top/i.test(RESEARCH_OFF_REPLY), "it does not explain how to apply");
});

async function turn(message: string, history: any[], deps: MarketDeps, input: Record<string, unknown>, reply: string) {
  let step = 0;
  const model = async () => (++step === 1 ? { content: [{ type: "tool_use", id: `f${history.length}`, name: "research_company", input }], stop_reason: "tool_use" } : { content: [{ type: "text", text: reply }], stop_reason: "end_turn" });
  const t: any = await agentTurn({ message, history, stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: deps } as any);
  return { t, call: t.tool_calls.find((c: any) => c.name === "research_company") };
}

Deno.test("F.2 replay with research on: a sourced chat answer, interpretation labelled, grounded questions, sources listed", async () => {
  const w = world();
  const a = await turn(F2A, [], w.deps, { company: "Stripe", role: "data analyst intern", question: F2A, format: "inline", sites: ["stripe.example"] },
    "Stripe Billing lets businesses bill customers with subscriptions and invoices [1]. The Data Analyst Intern will define metrics and build reports and dashboards for business teams [7]. Stripe has a demanding culture [3]. Stripe is the best place to start your career. Read more at https://stripe.example/jobs.");
  eq([a.call.ok, a.call.effect, w.published.length], [true, "read", 0], "an answer in chat makes no File");
  const r = a.t.reply as string;
  ok(/Stripe Billing lets businesses bill customers with subscriptions and invoices \[\d\]\./.test(r), r);
  ok(!/best place to start/.test(r), "an unsourced opinion stated as fact is removed");
  ok(!/demanding culture/.test(r), "a sentence its cited page does not say is removed (cite fidelity)");
  ok(/The Data Analyst Intern will define metrics and build reports and dashboards for business teams \[7\]/.test(r), r);
  ok(/My interpretation, not a sourced fact: Stripe is easier to understand as payments plus software/.test(r), "interpretation is labelled");
  ok(/Questions you could ask:\n1\. Your team is working on blocking fraudulent payments with Radar\. How do you decide between/.test(r), r);
  ok(/Not established by these sources:\n- Which team the role sits on/.test(r) && /\[\d\] is paywalled/.test(r) && /refuses\.example: not read/.test(r), "concerns and limits are listed");
  ok(/\[1\] [^\n]+: https:\/\/[^\s]+ \(read Nov 9, 2026\)/.test(r), "numbered sources with links, as asked");
  ok(!ACTIONS.test(r), "no batch, list, intro or outreach");
  // The correction turn, after the first: still research, still in chat.
  const b = await turn(F2B, [{ role: "user", content: F2A }, { role: "assistant", content: r }], w.deps, { company: "Stripe", role: "data analyst intern", question: F2B, format: "inline", sites: ["stripe.example"] },
    "Radar uses machine learning to help businesses block fraudulent payments [2].");
  ok(/Radar uses machine learning/.test(b.t.reply) && /Questions you could ask:/.test(b.t.reply) && !ACTIONS.test(b.t.reply), b.t.reply);
});

Deno.test("F.2 (d) research that cannot run names the specific blocker", async () => {
  const blocked = { ...world().deps, read: (u: string[]) => fetchSources(u, { fetch: (async () => new Response("no", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch, resolver: PUBLIC, now: () => NOW }) } as MarketDeps;
  const t = await turn(F2B, [], blocked, { company: "Stripe", role: "data analyst intern", question: F2B, format: "inline", sites: ["stripe.example"] }, "Here is how to apply to Stripe: go to their careers page.");
  ok(/I couldn't do this research: no source about Stripe could be opened \(stripe\.example: not read, because it answered with an error/.test(t.t.reply), t.t.reply);
  ok(!/how to apply/i.test(t.t.reply), "no apply instructions instead of the blocker");
  // No search result at all is its own blocker.
  const none = { ...world().deps, search: { id: "first_party" as const, needsKey: false, search: async () => ({ hits: [], notes: [], provider: "first_party", searches: 1 }) } } as MarketDeps;
  const n = await turn(F2B, [], none, { company: "Stripe", question: F2B, format: "inline" }, "Stripe is a payments company.");
  ok(/no source about Stripe was found to open/.test(n.t.reply), n.t.reply);
  void ALL; void companyWeb; void U;
});
