// BETA C04 (2026-11-06): "A customer support job offered Jordan $24/hour ... Should Jordan counter, and how? Draft a short counter
// email for review only." The router's counter draft asked the employer to "meet me at $24 an hour" (the offer itself, taken for
// the ask by parseOfferFigures' first-match), and nothing answered whether to counter. Now the offer and the ask are separate
// figures; with no ask figure the draft carries a fill-in the person must replace and the turn asks for the target; a "should I
// counter" turn goes to the brain. A figure the person names ("counter at $27/hour") is the ask. Held, sends 0.
// Memory stores, fixed clock, no model, no network.   deno test -A --no-check tests/architect/counter-offer-20261106.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { counterDecisionAsk, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const C04 = "Fictional beta scenario, not my profile. Jordan Lee has two years of retail customer-service experience and Excel skills. No external actions and no changes to my profile. A customer support job offered Jordan $24/hour, with no other terms provided. Should Jordan counter, and how? Draft a short counter email for review only. Separate advice from unverified market claims.";
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-co", threadId: "t-co", now: Date.UTC(2026, 10, 6, 15), snapshot: null, accountPersistence: true });
const STAGED = { get: (k: string) => (k === "CAREER_BRAIN" ? "staged" : undefined) };
const ask = (b: string) => b.match(/meet me at[^?]*\?/)?.[0] ?? "";

Deno.test("CO-1 C04: the draft never asks for the offered $24; a fill-in is held, the person is asked for a target", () => {
  const r = host.runTurn(C04, fresh());
  eq(r.intent, "negotiation_draft");
  const res = r.result, body: string = res.draft.body;
  assert(!/meet me at \$\s?24/.test(body), `asks for the offer: ${ask(body)}`);
  assert(!/\$\s?24[^.?]*\?/.test(ask(body)), "the ask line holds no $24");
  assert(/\[your target hourly rate\]/.test(ask(body)), `ask line is a fill-in: ${ask(body)}`);
  eq(res.awaiting, "target_hourly_rate");
  eq(res.resultStatus, "awaiting_user");
  eq(res.sends, 0);
  assert(res.draft.kind === "counter_email" && /nothing sent/.test(res.reply), "held, nothing sent");
  assert(/what hourly rate do you want to ask for/i.test(res.reply), "asks for the target");
  assert(/offer, not an ask/.test(res.reply), "says $24 is the offer");
});

Deno.test("CO-2 C04: the decision is addressed, and no figure is invented (no benchmark claimed)", () => {
  const res = host.runTurn(C04, fresh()).result;
  assert(/whether to counter is your decision/i.test(res.reply), res.reply);
  assert(/no benchmark figure is claimed/i.test(res.reply), "the sourced-or-nothing benchmark sentence rides");
  eq(res.counterDecision, true);
  assert(!/\$\s?(?:2[5-9]|3\d)\b/.test(res.reply + res.draft.body), "no invented target");
});

Deno.test("CO-3 C04 goes to the brain for the decision (counter_decision); the draft stays the router's fallback", () => {
  const d = stagedDecision({ env: STAGED, message: C04, ctx: fresh(), host, structured: false });
  eq([d.brain, d.reason, d.intent], [true, "counter_decision", "negotiation_draft"]);
  const probe = host.runTurn(C04, fresh());
  assert(counterDecisionAsk(C04, probe.intent, probe.result));
  assert(!counterDecisionAsk("Draft the counter email, counter at $27/hour.", probe.intent, probe.result), "not a question");
  assert(!counterDecisionAsk(C04, "negotiation_advice", probe.result));
  assert(!counterDecisionAsk(C04, probe.intent, { ...probe.result, awaiting: undefined }), "a draft with a figure stays code's");
});

Deno.test("CO-4 a named figure is the ask: 'counter at $27/hour' yields $27 (same message, and as a follow-up)", () => {
  const one = host.runTurn("I got an offer of $24/hour for a support role. Draft the counter email, counter at $27/hour.", fresh());
  eq(one.intent, "negotiation_draft");
  assert(/meet me at \$27 an hour\?/.test(one.result.draft.body), ask(one.result.draft.body));
  assert(/Thank you for the offer — \$24 an hour/.test(one.result.draft.body), "the offer is restated as the offer");
  eq([one.result.sends, one.result.awaiting], [0, undefined]);
  const ctx = fresh();
  host.runTurn(C04, ctx);
  const two = host.runTurn("counter at $27/hour", ctx);
  eq(two.intent, "negotiation_draft");
  assert(/meet me at \$27 an hour\?/.test(two.result.draft.body), ask(two.result.draft.body));
  eq(two.result.sends, 0);
  assert(!stagedDecision({ env: STAGED, message: "counter at $27/hour", ctx, host, structured: false }).brain, "a figure stays code's");
});

Deno.test("CO-5 the offer is never the ask, even when the person names it as the ask or a lower number", () => {
  for (const m of ["They offered me $24/hour. Draft the counter email, counter at $24/hour.", "They offered me $24/hour. Draft the counter email, ask for $22/hour."]) {
    const body: string = host.runTurn(m, fresh()).result.draft.body;
    assert(!/meet me at \$\s?(24|22)/.test(body), `${m}: ${ask(body)}`);
    assert(/\[your target hourly rate\]/.test(body), m);
  }
});

Deno.test("CO-6 the offer stays $24 when the person states the ask in the same message (want / I'd like / meet me at)", () => {
  for (const ask28 of ["I want $28/hour.", "I'd like $28/hour.", "Would you meet me at $28 an hour?"]) {
    const m = `They offered me $24/hour for a support role. Draft a counter email. ${ask28}`;
    const body: string = host.runTurn(m, fresh()).result.draft.body;
    assert(/Thank you for the offer — \$24 an hour/.test(body), `${m}: offer restated wrongly`);
    assert(/meet me at \$28 an hour\?/.test(body), `${m}: ${ask(body)}`);
  }
});

Deno.test("CO-7 the blank is not claimed to be code-blocked: the reply says it is not ready to send", () => {
  const res = host.runTurn(C04, fresh()).result;
  assert(!/cannot be approved|not approvable/i.test(res.reply), res.reply);
});
