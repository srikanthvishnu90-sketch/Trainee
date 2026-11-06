// G3 (Greptile P1 on PR #549): with a $24/hour offer on record, "Draft the counter email at $28/hour" was parsed as a NEW
// offer of $28 (the wording matched no ask cue), replacing the recorded $24; the draft thanked the employer for a $28 offer.
// The recorded offer stays unless the message REPORTS a new one; a figure in a counter-drafting request is the ASK.
// Final draft text AND saved thread/offer state, through the host's runTurn. Memory stores, fixed clock, no model, no network.
//   deno test -A --no-check tests/architect/counter-draft-wording-20261106.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
const STAGED = { get: (k: string) => (k === "CAREER_BRAIN" ? "staged" : undefined) };

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-cdw", threadId: "t-cdw", now: Date.UTC(2026, 10, 6, 15), snapshot: null, accountPersistence: true });
const OFFER = "I got an offer of $24/hour for a support role.";
const askLine = (b: string) => b.match(/meet me at[^?]*\?/)?.[0] ?? "";

// The offer on record (thread + ctx.offer) after a turn.
const recorded = (ctx: any) => {
  const th = ctx.negotiationThread ?? {};
  return { hourly: th.hourly ?? null, counter: th.counter?.hourly ?? null, offerRate: ctx.offer?.hourly_rate ?? null };
};

for (const msg of ["Draft the counter email at $28/hour", "write the counter at $28 an hour", "counter email asking $28/hour", "propose $28/hour"]) {
  Deno.test(`CDW the offer stays $24 and $28 is the ask: "${msg}"`, () => {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    eq(recorded(ctx).hourly, 24, "the offer is on record before the draft");
    const r = host.runTurn(msg, ctx);
    eq(r.intent, "negotiation_draft");
    const body: string = r.result.draft.body;
    assert(/Thank you for the offer — \$24 an hour/.test(body), `thanks for the wrong offer: ${body}`);
    assert(/meet me at \$28 an hour\?/.test(body), `ask line: ${askLine(body)}`);
    assert(!/\$28 an hour[^.]*\. I am excited/.test(body), "$28 is not restated as the offer");
    eq(r.result.sends, 0);
    const st = recorded(ctx);
    eq(st.hourly, 24, "thread offer kept");
    eq(st.counter, 28, "thread counter is the ask");
    assert(st.offerRate == null || st.offerRate === 24, `ctx.offer rate replaced: ${st.offerRate}`);
  });
}

Deno.test("CDW a message that REPORTS a new offer replaces the record: 'they came back and offered $26/hour now, draft a counter at $30'", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("they came back and offered $26/hour now, draft a counter at $30", ctx);
  eq(r.intent, "negotiation_draft");
  const body: string = r.result.draft.body;
  assert(/Thank you for the offer — \$26 an hour/.test(body), body);
  assert(/meet me at \$30 an hour\?/.test(body), askLine(body));
  eq(r.result.sends, 0);
  const st = recorded(ctx);
  eq([st.hourly, st.counter], [26, 30]);
});

Deno.test("CDW existing CO control: 'counter at $28/hour' after $24 still works", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("Counter at $28/hour", ctx);
  const body: string = r.result.draft.body;
  assert(/Thank you for the offer — \$24 an hour/.test(body) && /meet me at \$28 an hour\?/.test(body), body);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [24, 28]);
});

// Greptile P1s on PR #557.
Deno.test("CDW an advice question about a figure is not a draft: nothing is drafted and no counter is saved", () => {
  for (const msg of ["Should I propose $28/hour?", "is it ok to propose $28/hour?", "would a counter email asking $28/hour be too much?"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    assert(r.intent !== "negotiation_draft", `${msg}: drafted (${r.intent})`);
    assert(!r.result?.draft, `${msg}: carries a draft`);
    eq(recorded(ctx).counter, null, `${msg}: counter saved`);
    eq(recorded(ctx).hourly, 24, `${msg}: offer changed`);
    eq(r.result?.sends ?? 0, 0);
  }
});

Deno.test("CDW a bare dollar figure with another purpose is never the hourly ask", () => {
  for (const msg of ["Draft a counter email asking for $500 relocation allowance", "Draft a counter email asking for a relocation allowance of $500", "Draft a counter email asking for $5000 per year more"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    const body: string = r.result?.draft?.body ?? "";
    assert(!/\$\s?(500|5000)\s+an hour/.test(body), `${msg}: ${askLine(body)}`);
    assert(recorded(ctx).counter !== 500 && recorded(ctx).counter !== 5000, `${msg}: saved as hourly counter`);
    eq(recorded(ctx).hourly, 24);
  }
});

Deno.test("CDW '$28/hour and a $2,000 signing bonus' keeps 28 as the hourly ask and the bonus is not turned into hourly", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("Draft a counter asking for $28/hour and a $2,000 signing bonus", ctx);
  const body: string = r.result.draft.body;
  assert(/meet me at \$28 an hour\?/.test(body), askLine(body));
  assert(!/\$2,?000 an hour/.test(body), body);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [24, 28]);
});

// Round 3 (Greptile on #557): who said the figure, and in what unit, decides its role.
const TABLE: Array<[string, number, number | null]> = [
  // [message after a $24/hour offer on record, offer kept, ask]
  ["They proposed $26/hour and I want you to draft a counter at $30/hour", 26, 30],
  ["Draft a counter at $950 per week", 24, null],
  ["Draft the counter email with a rate of $28/hour", 24, 28],
  ["Draft a counter email asking for $500 relocation allowance", 24, null],
  ["Draft a counter asking for $28/hour and a $2,000 signing bonus", 24, 28],
];
for (const [msg, offer, ask] of TABLE) {
  Deno.test(`CDW roles: "${msg}"`, () => {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    eq(r.intent, "negotiation_draft");
    const body: string = r.result.draft.body;
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(body), `offer: ${body}`);
    if (ask != null) assert(new RegExp(`meet me at \\$${ask} an hour\\?`).test(body), `ask: ${askLine(body)}`);
    else assert(/\[your target hourly rate\]/.test(body), `placeholder expected: ${askLine(body)}`);
    assert(!/\$(?:950|500|2,?000) an hour/.test(body), body);
    eq(r.result.sends, 0);
    eq([recorded(ctx).hourly, recorded(ctx).counter], [offer, ask]);
  });
}
Deno.test("CDW 'What is a counter offer?' is a question: no draft, no saved counter", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("What is a counter offer?", ctx);
  assert(r.intent !== "negotiation_draft" && !r.result?.draft, `${r.intent}`);
  eq(recorded(ctx).counter, null);
  eq(r.result?.sends ?? 0, 0);
});
// Round 4: every write of the recorded offer takes ONLY the employer-role figure; the ask goes to the counter.
const step = (ctx: any, msg: string, offer: number, ask: number | null) => {
  const r = host.runTurn(msg, ctx);
  eq(r.intent, "negotiation_draft", msg);
  const body: string = r.result.draft.body;
  assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(body), `${msg}: ${body}`);
  if (ask != null) assert(new RegExp(`meet me at \\$${ask} an hour\\?`).test(body), `${msg}: ${askLine(body)}`);
  eq(r.result.sends, 0);
  const st = recorded(ctx);
  eq([st.hourly, st.counter, st.offerRate ?? offer], [offer, ask, offer], `${msg}: saved state ${JSON.stringify(st)}`);
};
Deno.test("CDW offer and ask in one message, then plain and 'ask for $30' follow-ups, keep $24 as the offer", () => {
  const ctx = fresh();
  step(ctx, "They offered $24/hour. I want $28/hour. Draft the counter email.", 24, 28);
  step(ctx, "Now draft the counter email", 24, 28);
  step(ctx, "Now draft the counter email, ask for $30", 24, 30);
});
Deno.test("CDW current pay is neither the offer nor the ask", () => {
  const a = fresh();
  host.runTurn(OFFER, a);
  step(a, "I make $22/hour now, draft the counter email at $28/hour", 24, 28);
  const b = fresh();
  step(b, "They offered $24/hour and I make $22/hour now. Draft a counter at $27/hour.", 24, 27);
  const c = fresh();
  step(c, "I currently earn $22/hour. They offered $24/hour. Draft a counter at $27/hour.", 24, 27);
});
Deno.test("CDW a new employer offer updates the saved offer (thread and ctx.offer), not just the draft", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  step(ctx, "They came back and offered $26/hour, draft a counter at $30", 26, 30);
  eq(recorded(ctx).offerRate, 26);
});
Deno.test("CDW 'Should I counter at $28/hour?' is a decision, not a draft", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("Should I counter at $28/hour?", ctx);
  assert(!r.result?.draft, `drafted: ${r.intent}`);
  eq(recorded(ctx).counter, null);
  eq(recorded(ctx).hourly, 24);
  eq(r.result?.sends ?? 0, 0);
  const d = stagedDecision({ env: STAGED, message: "Should I counter at $28/hour?", ctx, host, structured: false });
  assert(d.brain, `brain=${d.brain} reason=${d.reason}`);
});
Deno.test("CDW '$22 now; they offered $24; counter at $27' reaches the negotiation path with offer 24 and ask 27", () => {
  const ctx = fresh();
  const r = host.runTurn("$22 now; they offered $24/hour; counter at $27", ctx);
  eq(r.intent, "negotiation_draft");
  assert(/Thank you for the offer — \$24 an hour/.test(r.result.draft.body) && /meet me at \$27 an hour\?/.test(r.result.draft.body), r.result.draft.body);
});
Deno.test("CDW current pay is never saved as the offer, unitless or /hour, over two turns", () => {
  for (const first of ["my current job pays $22/hour; they offered $24; draft a counter at $27/hour", "my current job pays $22/hour; they offered $24/hour; draft a counter at $27/hour"]) {
    const ctx = fresh();
    step(ctx, first, 24, 27);
    step(ctx, "Draft the counter email.", 24, 27);
    eq(recorded(ctx).offerRate, 24, first);
  }
});
Deno.test("CDW 'a rate of' after the employer's verb stays the offer; a unit word must attach to its figure; negations never attach", () => {
  const cases: Array<[string, number, number, boolean]> = [
    // [first message, offer, ask, fresh thread (no $24 on record)]
    ["They offered a rate of $26/hour; draft a counter at $30/hour", 26, 30, false],
    ["They offered a rate of $26/hour and a $1,000 bonus; counter at $30/hour", 26, 30, false],
    ["Draft a counter at $28 with no relocation allowance", 24, 28, false],
    ["Draft a counter at $28/hour, no signing bonus needed", 24, 28, false],
    ["They offered $24/hour. Draft a counter at $28 without a signing bonus.", 24, 28, true],
  ];
  for (const [msg, offer, ask, isFresh] of cases) {
    const ctx = fresh();
    if (!isFresh) host.runTurn(OFFER, ctx);
    step(ctx, msg, offer, ask);
    step(ctx, "Draft the counter email.", offer, ask);
    assert(!/\$1,?000 an hour/.test(host.runTurn("Draft the counter email.", ctx).result.draft.body), msg);
  }
});
Deno.test("CDW the C04 message verbatim still blanks the ask and keeps the offer", () => {
  const C04 = "Fictional beta scenario, not my profile. Jordan Lee has two years of retail customer-service experience and Excel skills. No external actions and no changes to my profile. A customer support job offered Jordan $24/hour, with no other terms provided. Should Jordan counter, and how? Draft a short counter email for review only. Separate advice from unverified market claims.";
  const ctx = fresh();
  const r = host.runTurn(C04, ctx);
  assert(/\[your target hourly rate\]/.test(r.result.draft.body) && /Thank you for the offer — \$24 an hour/.test(r.result.draft.body));
  eq(r.result.sends, 0);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [24, null]);
});
