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
    if (/\$24\/hour/.test(first)) {
      step(ctx, first, 24, 27);
      step(ctx, "Draft the counter email.", 24, 27);
      eq(recorded(ctx).offerRate, 24, first);
    } else {
      // Unitless "$24" in a fresh thread: no recorded offer to take a unit from, so it fails safe (the offer is not recorded as
      // hourly). The invariant this test owns still holds: current pay ($22) is never the offer, and the ask $27 stays.
      const r = host.runTurn(first, ctx);
      eq(r.intent, "negotiation_draft");
      assert(!/Thank you for the offer — \$22 an hour/.test(r.result.draft.body), r.result.draft.body);
      assert(recorded(ctx).hourly !== 22 && recorded(ctx).offerRate !== 22, JSON.stringify(recorded(ctx)));
      assert(/meet me at \$27 an hour\?/.test(r.result.draft.body), "the explicit $27/hour ask is in the draft: " + r.result.draft.body);
      eq(recorded(ctx).counter, 27);
    }
  }
});
Deno.test("CDW current pay is never saved as the offer: unitless offer after the offer is recorded", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  step(ctx, "my current job pays $22/hour; they offered $24; draft a counter at $27/hour", 24, 27);
  step(ctx, "Draft the counter email.", 24, 27);
});
Deno.test("CDW a unit word before the amount is an explicit unit ('The hourly offer is $24'), no recorded offer needed", () => {
  const run = (msg: string) => { const ctx = fresh(); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  let t = run("The hourly offer is $24; draft a counter at $28/hour");
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$28 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 28]);
  t = run("Their hourly rate of $26, I want to counter at $30/hour");
  assert(/Thank you for the offer — \$26 an hour/.test(t.body) && /meet me at \$30 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [26, 30]);
  t = run("the hourly offer is $24 plus $200 for each shift; counter at $28/hour");
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && !/\$200 an hour/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 28]);
  t = run("they offered $24; counter at $28/hour");
  assert(!/Thank you for the offer — \$24 an hour/.test(t.body), "unitless with no recorded offer fails safe: " + t.body);
  eq(recorded(t.ctx).hourly, null);
});
Deno.test("CDW 'a rate of' after the employer's verb stays the offer; a unit word must attach to its figure; negations never attach", () => {
  const cases: Array<[string, number, number | null, boolean]> = [
    // [first message, offer, ask, fresh thread (no $24 on record)]
    ["They offered a rate of $26/hour; draft a counter at $30/hour", 26, 30, false],
    ["They offered a rate of $26/hour and a $1,000 bonus; counter at $30/hour", 26, 30, false],
    ["Draft a counter at $28 with no relocation allowance", 24, null, false], // allowlist: unitless + unlisted tail fails safe
    ["Draft a counter at $28/hour, no signing bonus needed", 24, 28, false],
    ["They offered $24/hour. Draft a counter at $28 without a signing bonus.", 24, null, true], // fails safe
  ];
  for (const [msg, offer, ask, isFresh] of cases) {
    const ctx = fresh();
    if (!isFresh) host.runTurn(OFFER, ctx);
    step(ctx, msg, offer, ask);
    step(ctx, "Draft the counter email.", offer, ask);
    assert(!/\$1,?000 an hour/.test(host.runTurn("Draft the counter email.", ctx).result.draft.body), msg);
  }
});
Deno.test("CDW an unlabelled hourly figure never replaces a recorded offer: in a counter request it is the ask", () => {
  for (const msg of ["a relocation allowance of $500 and $28/hour; draft the counter", "$28/hour please, draft the counter"]) {
    const ctx = fresh();
    host.runTurn("They offered $24/hour.", ctx);
    eq(recorded(ctx).hourly, 24);
    step(ctx, msg, 24, 28);
    step(ctx, "Draft the counter email.", 24, 28);
  }
});
Deno.test("CDW 'They pay $24/hour' then '$26/hour' alone keeps 24 (unclear, not a silent replace)", () => {
  const ctx = fresh();
  host.runTurn("They pay $24/hour.", ctx);
  eq(recorded(ctx).hourly, 24);
  host.runTurn("$26/hour", ctx);
  eq(recorded(ctx).hourly, 24);
  eq(recorded(ctx).offerRate ?? 24, 24);
});
Deno.test("CDW a purpose amount is never the hourly ask ('for relocation', no 'for', 'for moving costs')", () => {
  const cases: Array<[string, number | null]> = [
    ["Draft a counter email asking for $500 for relocation", null],
    ["Draft a counter email asking for $5,000 relocation", null],
    ["Draft a counter email asking for $500 for moving costs and $28/hour", 28],
    ["Draft a counter email asking for $900", null],
    ["Draft a counter at $30", 30],
  ];
  for (const [msg, ask] of cases) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    step(ctx, msg, 24, ask);
    step(ctx, "Draft the counter email.", 24, ask);
    assert(!/\$(?:500|5,?000|900) an hour/.test(host.runTurn("Draft the counter email.", ctx).result.draft.body), msg);
  }
});
Deno.test("CDW an explicit ask always beats an unlabelled earlier figure", () => {
  for (const [msg, ask] of [["$26/hour was the earlier number; draft the counter at $30", 30], ["$26/hour was mentioned earlier, counter at $30/hour", 30]] as Array<[string, number]>) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    step(ctx, msg, 24, ask);
    step(ctx, "Draft the counter email.", 24, ask);
  }
});
Deno.test("CDW job wording ('for a childcare role') does not hide the counter; payment purposes still do", () => {
  const cases: Array<[string, number | null]> = [
    // Unitless figures now fail safe (placeholder) when the tail is not on the allowlist; explicit hourly units keep the job-wording rule.
    ["Draft a counter at $28 for a childcare role", null],
    ["counter at $28/hour for a childcare position", 28],
    ["counter at $30/hour for a travel nurse role", 30],
    ["Draft a counter at $28 and $300 for childcare costs", 28],
    ["Draft a counter asking for $500 for relocation", null],
  ];
  for (const [msg, ask] of cases) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    step(ctx, msg, 24, ask);
    step(ctx, "Draft the counter email.", 24, ask);
    assert(!/\$(?:300|500) an hour/.test(host.runTurn("Draft the counter email.", ctx).result.draft.body), msg);
  }
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  step(ctx, "Their rate is $26/hour; draft a counter at $30", 24, 30);
});
Deno.test("CDW a unitless cued ask takes the recorded offer's unit up to 3x it; the $300 cap applies only with no offer", () => {
  const hi = (msg: string, ask: number) => {
    const ctx = fresh();
    host.runTurn("I got an offer of $300/hour.", ctx);
    const r = host.runTurn(msg, ctx);
    assert(new RegExp(`meet me at \\$${ask} an hour\\?`).test(r.result.draft.body), `${msg}: ${askLine(r.result.draft.body)}`);
    eq(recorded(ctx).counter, ask);
    eq(recorded(ctx).hourly, 300);
  };
  hi("Draft a counter at $350", 350);
  hi("counter at $400", 400);
  const a = fresh();
  host.runTurn(OFFER, a);
  step(a, "counter at $500 for relocation", 24, null);
  const b = fresh();
  host.runTurn(OFFER, b);
  step(b, "counter at $28", 24, 28);
  const c = fresh();
  const r = host.runTurn("counter at $350", c);
  assert(!/meet me at \$350 an hour/.test(r.result?.draft?.body ?? ""), "no offer recorded: the $300 cap holds");
});
Deno.test("CDW 'for a <purpose noun>' is one-time money; 'for a <noun> role' describes the job", () => {
  const withOffer = (offer: string, msg: string, ask: number | null) => {
    const ctx = fresh();
    host.runTurn(offer, ctx);
    const r = host.runTurn(msg, ctx);
    const body: string = r.result?.draft?.body ?? "";
    if (ask == null) {
      assert(!/meet me at \$\d+ an hour\?/.test(body), `${msg}: ${askLine(body)}`);
      eq(recorded(ctx).counter, null, `${msg}: saved as counter`);
    } else {
      assert(new RegExp(`meet me at \\$${ask} an hour\\?`).test(body), `${msg}: ${askLine(body)}`);
      eq(recorded(ctx).counter, ask);
    }
  };
  const HI = "I got an offer of $300/hour.";
  withOffer(HI, "Draft a counter asking for $500 for a relocation allowance", null);
  withOffer(HI, "counter at $300 for a signing bonus", null);
  withOffer(HI, "counter at $350 for the role", 350);
  withOffer(OFFER, "counter at $28 for a childcare role", null); // unitless + role wording fails safe
  withOffer(OFFER, "counter at $30/hour for a travel nurse role", 30);
});
Deno.test("CDW the C04 message verbatim still blanks the ask and keeps the offer", () => {
  const C04 = "Fictional beta scenario, not my profile. Jordan Lee has two years of retail customer-service experience and Excel skills. No external actions and no changes to my profile. A customer support job offered Jordan $24/hour, with no other terms provided. Should Jordan counter, and how? Draft a short counter email for review only. Separate advice from unverified market claims.";
  const ctx = fresh();
  const r = host.runTurn(C04, ctx);
  assert(/\[your target hourly rate\]/.test(r.result.draft.body) && /Thank you for the offer — \$24 an hour/.test(r.result.draft.body));
  eq(r.result.sends, 0);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [24, null]);
});

Deno.test("CDW allowlist: a cued unitless figure is hourly only with an empty or hourly/filler tail", () => {
  const run = (offer: string, msg: string) => { const ctx = fresh(); host.runTurn(offer, ctx); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  for (const msg of ["counter at $60 on top for relocation", "counter at $30 to cover tuition", "counter at $40 for the first month's rent", "counter at $50 for each shift", "counter at $28 every week"]) {
    const { ctx, body } = run(OFFER, msg);
    assert(!/meet me at \$\d+ an hour/.test(body), `${msg}: ${askLine(body)}`);
    assert(/\[your target hourly rate\]/.test(body), `${msg}: placeholder expected`);
    eq(recorded(ctx).counter, null, msg);
    eq(recorded(ctx).hourly, 24, msg);
  }
  for (const msg of ["counter at $28", "counter at $28.", "counter at $28 an hour", "counter at $28 for the role", "counter at $28 please", "counter at $30/hour for a travel nurse role"]) {
    const { ctx, body } = run(OFFER, msg);
    const want = msg.includes("$30") ? 30 : 28;
    assert(new RegExp(`meet me at \\$${want} an hour\\?`).test(body), `${msg}: ${askLine(body)}`);
    eq(recorded(ctx).counter, want, msg);
  }
  const hi = run("I got an offer of $300/hour.", "counter at $350");
  assert(/meet me at \$350 an hour\?/.test(hi.body), askLine(hi.body));
  const rel = run("I got an offer of $300/hour.", "counter at $500 for a relocation allowance");
  assert(!/meet me at \$500 an hour/.test(rel.body), askLine(rel.body));
  eq(recorded(rel.ctx).counter, null);
});

Deno.test("CDW '$50 for travel to work' is not an hourly ask: placeholder, nothing saved as the counter", () => {
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("Draft a counter email asking for $50 for travel to work", ctx);
  const body: string = r.result.draft.body;
  assert(/\[your target hourly rate\]/.test(body) && !/meet me at \$50 an hour/.test(body), askLine(body));
  eq(recorded(ctx).counter, null);
  eq(recorded(ctx).hourly, 24);
});

Deno.test("CDW a unitless employer figure never inherits its unit from another figure (allowlist applies to offers too)", () => {
  const go = (msg: string) => { const ctx = fresh(); host.runTurn(OFFER, ctx); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  // tail "for each shift" is off the allowlist: the recorded offer stays and is what the draft thanks for
  let t = go("They offered $200 for each shift; draft a counter at $28/hour");
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$28 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter, recorded(t.ctx).offerRate], [24, 28, 24]);
  // clean tail, within 3x of the recorded $24: takes the recorded offer's hourly unit, so the offer is $26/hour
  t = go("They offered $26; counter at $30/hour");
  assert(/Thank you for the offer — \$26 an hour/.test(t.body) && /meet me at \$30 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [26, 30]);
  t = go("They offered $26/hour now; counter at $30");
  assert(/Thank you for the offer — \$26 an hour/.test(t.body) && /meet me at \$30 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [26, 30]);
  t = go("They offered $1,000 a week; counter at $30/hour");
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$30 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter, recorded(t.ctx).offerRate], [24, 30, 24]);
});

Deno.test("CDW the unit-before-amount rule is an exact pattern: 'hourly staff get a $500 bonus' is no offer", () => {
  const run = (msg: string) => { const ctx = fresh(); const r = host.runTurn(msg, ctx); return { ctx, r, body: String(r.result?.draft?.body ?? "") }; };
  let t = run("hourly staff get a $500 bonus");
  eq([recorded(t.ctx).hourly, recorded(t.ctx).offerRate ?? null], [null, null]);
  assert(!/\$500 an hour/.test(t.body + String(t.r.result?.reply ?? "")), "500 is not hourly");
  t = run("hourly bonus of $500; counter at $28/hour");
  eq(recorded(t.ctx).hourly, null);
  assert(!/\$500 an hour/.test(t.body), t.body);
  assert(t.body === "" || /meet me at \$28 an hour\?/.test(t.body), t.body);
  t = run("the hourly pay is $25; counter at $29/hour");
  assert(/Thank you for the offer — \$25 an hour/.test(t.body) && /meet me at \$29 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [25, 29]);
  t = run("hourly rate for nights is $30; counter at $35/hour");
  eq(recorded(t.ctx).hourly, null); // intervening words: unitless, no recorded offer, fail-safe
  assert(!/Thank you for the offer — \$30 an hour/.test(t.body), t.body);
});

Deno.test("CDW an ask cue carries across 'and' in a clause; the thanks figure is only ever an employer-cued or recorded offer", () => {
  const ask = (body: string) => /meet me at \$28 an hour\?/.test(body);
  for (const off of ["$52,000 a year", "$2,000 signing bonus", "$3,000 relocation", "$60,000 total comp"]) {
    const ctx = fresh();
    const r = host.runTurn(`They offered ${off} (ask for $500 relocation and $28 an hour). Draft the counter email.`, ctx);
    const body: string = r.result.draft.body;
    assert(ask(body), `${off}: ${askLine(body)}`);
    assert(!/Thank you for the offer — \$28 an hour/.test(body), `${off}: thanks for the ask: ${body}`);
    eq(recorded(ctx).hourly, null, off);
    eq(recorded(ctx).counter, 28, off);
  }
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  step(ctx, "the hourly wage was $24 — ask for $500 relocation and $28 an hour. Draft the counter email.", 24, 28);
  for (const off of ["$2,000 signing bonus", "$3,000 relocation", "$60,000 total comp"]) {
    const c2 = fresh();
    host.runTurn(OFFER, c2);
    step(c2, `the hourly wage was $24 — ask for $500 relocation and $28 an hour. They also offered ${off}. Draft the counter email.`, 24, 28);
  }
});
Deno.test("CDW the unitless-hourly window is [O/3, 3xO] of the recorded offer", () => {
  const hi = fresh();
  host.runTurn("I got an offer of $300/hour.", hi);
  host.runTurn("I got an offer of $26", hi);
  eq(recorded(hi).hourly, 300); // $26 is below 300/3: not hourly, the offer is unchanged
  const lo = fresh();
  host.runTurn(OFFER, lo);
  host.runTurn("I got an offer of $26", lo);
  eq(recorded(lo).hourly, 26); // within [8, 72] of $24: by design
});

Deno.test("CDW an explicit hourly figure in an offer clause is the offer; market and ask figures are not", () => {
  const run = (msg: string) => { const ctx = fresh(); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  let t = run("$24/hour is what they offered, counter at $28/hour");
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$28 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 28]);
  t = run("I got an offer — $60 an hour plus a $5,000 signing bonus.");
  eq(recorded(t.ctx).hourly, 60);
  t = run("the market rate is $30/hour; draft a counter at $28/hour");
  eq(recorded(t.ctx).hourly, null);
  assert(!/Thank you for the offer — \$30 an hour/.test(t.body), t.body);
  t = run("Glassdoor says $29/hour; counter at $28/hour");
  eq(recorded(t.ctx).hourly, null);
  t = run("I want $30/hour but they offered $24/hour");
  eq(recorded(t.ctx).hourly, 24);
});

Deno.test("CDW a current-pay figure never becomes or replaces the offer", () => {
  const rec = (msg: string, offer: number, ask: number, prior: boolean) => {
    const ctx = fresh();
    if (prior) host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    const body: string = r.result.draft.body;
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(body) && new RegExp(`meet me at \\$${ask} an hour\\?`).test(body), `${msg}: ${body}`);
    eq([recorded(ctx).hourly, recorded(ctx).counter, recorded(ctx).offerRate ?? offer], [offer, ask, offer], msg);
  };
  rec("my current job pays $26/hour; counter at $30/hour", 24, 30, true);
  rec("I make $22/hour now and they offered $24/hour; counter at $28/hour", 24, 28, false);
  rec("I'm at $26 an hour at my current job, draft a counter at $30/hour", 24, 30, true);
  rec("currently $20/hour, the offer is $24/hour, counter at $27/hour", 24, 27, false);
});
