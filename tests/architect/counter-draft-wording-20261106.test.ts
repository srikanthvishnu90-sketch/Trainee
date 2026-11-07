// G3 (Greptile P1 on PR #549): with a $24/hour offer on record, "Draft the counter email at $28/hour" was parsed as a NEW
// offer of $28 (the wording matched no ask cue), replacing the recorded $24; the draft thanked the employer for a $28 offer.
// The recorded offer stays unless the message REPORTS a new one; a figure in a counter-drafting request is the ASK.
// Final draft text AND saved thread/offer state, through the host's runTurn. Memory stores, fixed clock, no model, no network.
//   deno test -A --no-check tests/architect/counter-draft-wording-20261106.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision, counterAmbiguousAsk, routerAnswerBlock } from "../../supabase/functions/agent-chat/career_staged.ts";
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

// The market exit (#557 review rounds; D-007): a pay figure that shares a sentence with a third party (the market, competitors,
// others, the industry, averages, salary sites, other employers) is not attributed by code. Nothing is saved or drafted and the
// turn is held for the brain, which asks which figure is the employer's offer. Spec side of that rule:
const THIRD_SPEC = /\b(?:market|competitors?|others|industry|average|median|typical|glassdoor|levels\.fyi|payscale|salary\.com|indeed|employers|companies|other\s+(?:places|firms|roles|jobs|offers))\b/i;
const namesThird = (msg: string) => msg.split(/[?!;\n]|(?<!(?:^|[^A-Za-z])(?:e\.g|i\.e|u\.s|u\.k|approx|vs|etc|mr|mrs|ms|dr|inc|co|corp|ltd|jr|sr))(?<!(?:^|[^A-Za-z])no(?=\.\s+#?\d))\.(?=["'\u201d\u2019)\]]*(?:\s|$))/i).some((x) => THIRD_SPEC.test(x.replace(/counter[ -]?offers?/ig, "")) && /\$\s?\d/.test(x));
const ASKS: (string | null | undefined)[] = ["outreach_clarification", "career_catchall", null, undefined];
// Held: no figure from this message is saved (the recorded offer stays, or a different-company thread starts empty), nothing
// is drafted or sent, and the turn asks: it is flagged for the brain, or routed to a clarifying question.
const heldForBrain = (ctx: any, r: any, before: number | null, msg: string) => {
  const figs = [...msg.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const h = recorded(ctx).hourly;
  assert(h === before || h === null, `${msg}: held, the offer on record is not replaced (${h})`);
  assert(!figs.includes(h as number) || h === before, `${msg}: held, no figure from the message saved (${h})`);
  eq(recorded(ctx).counter, null, `${msg}: held, no counter saved`);
  assert(!r.result?.draft?.body, `${msg}: held, no draft`);
  assert(r.result?.counterAmbiguous === true || ASKS.includes(r.intent), `${msg}: held, it asks (${r.intent})`);
  eq(r.result?.sends ?? 0, 0, `${msg}: nothing sent`);
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

Deno.test("CDW a comma-split clause keeps the ask cue of its sentence: '(ask for a $2,000 signing bonus and $28/hour)' is an ask, not the offer", () => {
  const ctx = fresh();
  const r = host.runTurn("They offered $75/day (ask for a $2,000 signing bonus and $28/hour). Draft the counter email.", ctx);
  const body: string = r.result.draft.body;
  assert(/meet me at \$28 an hour\?/.test(body) && !/Thank you for the offer — \$28 an hour/.test(body), body);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [null, 28]);
});

Deno.test("CDW timing words ('now', 'right now') are never a current-pay cue", () => {
  const go = (msg: string, prior: boolean) => { const ctx = fresh(); if (prior) host.runTurn(OFFER, ctx); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  let t = go("Draft a counter at $28/hour right now", true);
  assert(/meet me at \$28 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 28]);
  t = go("They offered $26/hour right now.", false);
  eq(recorded(t.ctx).hourly, 26);
  t = go("I make $22/hour now and they offered $24/hour; counter at $28/hour", false);
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$28 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 28]);
  t = go("currently I earn $20/hour; counter at $27/hour", true);
  assert(/Thank you for the offer — \$24 an hour/.test(t.body) && /meet me at \$27 an hour\?/.test(t.body), t.body);
  eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, 27]);
  t = go("counter at $30/hour now", true);
  assert(/meet me at \$30 an hour\?/.test(t.body), t.body);
  eq(recorded(t.ctx).counter, 30);
});

Deno.test("CDW 'now' inside a current-pay phrase is a cue; explicit current-job wording beats a generic pay word, never an offer word", () => {
  const go = (msg: string) => { const ctx = fresh(); host.runTurn(OFFER, ctx); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  const ok = (msg: string, offer: number, ask: number) => {
    const t = go(msg);
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(t.body) && new RegExp(`meet me at \\$${ask} an hour\\?`).test(t.body), `${msg}: ${t.body}`);
    eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [offer, ask], msg);
  };
  ok("my job now pays $26/hour; counter at $30/hour", 24, 30);
  ok("I now earn $25/hour; counter at $30/hour", 24, 30);
  ok("They pay $26/hour at my current job; counter at $30/hour", 24, 30);
  ok("they offered $26/hour, more than at my current job; counter at $30/hour", 26, 30);
  const a = go("Draft a counter at $28/hour right now");
  assert(/meet me at \$28 an hour\?/.test(a.body), a.body);
  const b = fresh(); host.runTurn("They offered $26/hour right now.", b);
  eq(recorded(b).hourly, 26);
});

Deno.test("CDW a trailing current-job phrase applies only to the nearest figure before it", () => {
  const go = (msg: string) => { const ctx = fresh(); host.runTurn(OFFER, ctx); const r = host.runTurn(msg, ctx); return { ctx, body: String(r.result?.draft?.body ?? "") }; };
  const ok = (msg: string, offer: number, ask: number) => {
    const t = go(msg);
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(t.body) && new RegExp(`meet me at \\$${ask} an hour\\?`).test(t.body), `${msg}: ${t.body}`);
    eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [offer, ask], msg);
    assert(recorded(t.ctx).hourly !== 22 && recorded(t.ctx).offerRate !== 22, msg);
  };
  // The first three shapes ("$26 vs $22 at my job", "$26; I get $22 at my current job", "$22 at my job, they pay $26") are now AMBIGUOUS (see the ambiguity test below): held for the brain, not drafted.
  ok("They pay $26/hour at my current job; counter at $30/hour", 24, 30);
});

Deno.test("CDW ambiguous figures (current-job phrase, two pay figures, no offer word): nothing saved, no draft, the brain asks", () => {
  for (const msg of ["They pay $26/hr plus a $50 bonus at my job; draft a counter at $30/hr", "They pay $26/hr vs $22/hr at my job; draft a counter at $30/hr", "They pay $26/hr; I get $22/hr at my current job; counter at $30/hr", "$22/hr at my job, they pay $26/hr; counter at $30/hr"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    assert(!r.result?.draft, `${msg}: drafted`);
    eq(r.result?.sends ?? 0, 0);
    // structured state only: the branch writes no reply prose of its own (the advice path's reply is the fallback), no draft, no save
    eq([r.result.counterAmbiguous, r.result.awaiting, Array.isArray(r.result.figures)], [true, "which_figure_is_offer", true], msg);
    assert(r.result.figures.every((f: any) => Object.keys(f).sort().join() === "unit,value"), "figures carry no roles");
    assert(!/can't tell which figure|Which figure is the employer's new offer/i.test(String(r.result.reply ?? "")), `${msg}: canned clarification prose`);
    assert(counterAmbiguousAsk(r.intent, r.result), `${msg}: ${r.intent}`);
    eq([recorded(ctx).hourly, recorded(ctx).counter, recorded(ctx).offerRate ?? 24], [24, null, 24], msg);
    const ctx2 = fresh();
    host.runTurn(OFFER, ctx2);
    const d = stagedDecision({ env: STAGED, message: msg, ctx: ctx2, host, structured: false });
    eq([d.brain, d.reason], [true, "counter_ambiguous_figures"], msg);
    assert(Array.isArray(d.ambiguousFigures) && d.ambiguousFigures.length >= 2, `${msg}: the figures reach the brain`);
    assert(routerAnswerBlock(d).includes("ambiguous_figures") && routerAnswerBlock(d).includes('"value"'), msg);
  }
  // not ambiguous: an explicit offer word, or current pay with no competing employer figure
  const ok = (msg: string, offer: number, ask: number) => {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    const body: string = r.result?.draft?.body ?? "";
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(body) && new RegExp(`meet me at \\$${ask} an hour\\?`).test(body), `${msg}: ${body}`);
    eq([recorded(ctx).hourly, recorded(ctx).counter], [offer, ask], msg);
  };
  ok("they offered $26/hr, more than the $22/hr at my job; counter at $30/hr", 26, 30);
  ok("They pay $26/hour at my current job; counter at $30/hour", 24, 30);
  ok("my job now pays $26/hour; counter at $30/hour", 24, 30);
  ok("Draft a counter at $28/hour right now", 24, 28);
});

Deno.test("CDW the ambiguous fallback gives no call script, no commit wording and no figure but the recorded offer; a clear ask still gets its script", () => {
  for (const msg of ["They pay $26/hr vs $22/hr at my job; draft the counter email and tell me what to say on the call.", "They pay $26/hr plus a $50 bonus at my job; draft a counter at $30/hr and tell me what to say on the call.", "They pay $26/hr vs $22/hr at my job; counter scripts: what should I say on the call?"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    const reply = String(r.result?.reply ?? "");
    assert(r.result.counterAmbiguous === true && !r.result.draft, msg);
    assert(!/call script|word for word|OPEN:|ANCHOR:|IF PUSHED|your words for the call|verbatim/i.test(reply), `${msg}: script in the fallback: ${reply}`);
    assert(!/\b(?:accept|commit|sign today|stop (?:other|all)|yes today|say yes)\b/i.test(reply), `${msg}: commit wording: ${reply}`);
    const figs = [...reply.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => m[1]);
    assert(figs.every((f) => f === "24"), `${msg}: figures ${figs.join(",")}`);
    eq(recorded(ctx).hourly, 24);
    const ctx2 = fresh();
    host.runTurn(OFFER, ctx2);
    const d = stagedDecision({ env: STAGED, message: msg, ctx: ctx2, host, structured: false });
    eq([d.brain, d.reason], [true, "counter_ambiguous_figures"], msg);
  }
  const ctx = fresh();
  host.runTurn(OFFER, ctx);
  const r = host.runTurn("my offer is $24/hour, what should I say on the call to counter?", ctx);
  assert(/call script|word for word|OPEN:/i.test(String(r.result?.reply ?? "")), "an unambiguous ask still gets its script: " + String(r.result?.reply ?? "").slice(0, 120));
});

// Greptile P1 on 1419359c: an offer figure that shares a clause with the ask ("a counter at $30/hour against their $26/hour
// offer") was dropped because the ask cue of $30 was read as $26's. Each figure's own words now decide it.
Deno.test("CDW an offer figure in the same clause as the ask is the offer; the other figure's cue does not decide it", () => {
  const go = (prior: string | null, msg: string) => { const ctx = fresh(); if (prior) host.runTurn(prior, ctx); const r = host.runTurn(msg, ctx); return { ctx, r, body: String(r.result?.draft?.body ?? "") }; };
  const offerIs = (prior: string | null, msg: string, offer: number, ask: number) => {
    const t = go(prior, msg);
    if (namesThird(msg)) return heldForBrain(t.ctx, t.r, prior ? 24 : null, msg);
    eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [offer, ask], `${msg}: saved`);
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(t.body), `${msg}: thanks ${t.body}`);
    assert(new RegExp(`meet me at \\$${ask} an hour\\?`).test(t.body), `${msg}: ask ${t.body}`);
    eq(t.r.result?.sends ?? 0, 0, `${msg}: nothing sent`);
  };
  for (const prior of [OFFER, null]) {
    offerIs(prior, "Draft a counter at $30/hour against their $26/hour offer", 26, 30);
    offerIs(prior, "Draft a counter at $30/hour against their new $26/hour offer", 26, 30);
    offerIs(prior, "Write the counter at $30 an hour to their $26 an hour offer", 26, 30);
    offerIs(prior, "Counter at $30/hour since the market average is $28/hour vs their $26/hour offer", 26, 30);
  }
  // Still not the offer: a figure whose own words carry the ask, current pay, or a market cue.
  const keep = (msg: string, ask: number) => {
    const t = go(OFFER, msg);
    if (namesThird(msg)) return heldForBrain(t.ctx, t.r, 24, msg);
    eq([recorded(t.ctx).hourly, recorded(t.ctx).counter], [24, ask], `${msg}: the recorded $24 stays`);
    assert(/Thank you for the offer — \$24 an hour/.test(t.body), `${msg}: ${t.body}`);
  };
  keep("Draft a counter asking $30/hour plus $28/hour overtime offer", 30);
  keep("Draft a counter at $30/hour and mention I make $22/hour at my current job offer", 30);
  keep("Draft a counter at $30/hour, the market offers $28/hour", 30);
  keep("Draft a counter at $30/hour. The market offers $28/hour", 30);
  keep("Glassdoor says others are paying $28/hour, draft a counter at $30/hour", 30);
  keep("Draft a counter at $30/hour", 30);
  // The employer named after the market decides its own figure; an offer followed by a market remark is still the offer.
  offerIs(OFFER, "The market is $28/hour but they offered $26/hour, draft a counter at $30/hour", 26, 30);
  offerIs(OFFER, "They offered $26/hour which is below market. Draft a counter at $30/hour", 26, 30);
  // A third party is the source only as the subject of the offer word (review of 9b394f8e): naming the employer first keeps
  // the figure the employer's, and a market-only figure is never promoted back by the explicit-hourly rule.
  for (const prior of [OFFER, null]) {
    offerIs(prior, "They offer the market rate of $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "The company's average offer is $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "The recruiter said the market is tight and offered $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "Given the industry average, Acme offered $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They're matching the industry standard $26/hour offer. Draft a counter at $30/hour", 26, 30);
  }
  offerIs(OFFER, "They offered $26/hour while competitors offer $28/hour. Draft a counter at $30/hour", 26, 30);
  // A comparison with the market describes the employer's figure; it does not make it the market's (Greptile on 9b394f8e).
  for (const prior of [OFFER, null]) {
    offerIs(prior, "They offered a below market rate of $26/hour; draft a counter at $30/hour", 26, 30);
    offerIs(prior, "A below market $26/hour offer came in; draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They came back with an above-market $26/hour offer; draft a counter at $30/hour", 26, 30);
    offerIs(prior, "The offer is a below-average $26/hour; draft a counter at $30/hour", 26, 30);
  }
  offerIs(OFFER, "Their $26/hour offer is below market, the market pays $28/hour; draft a counter at $30/hour", 26, 30);
  // The offer word belongs to an earlier figure only right after it; a comma and a market phrase before this figure's own
  // amount leave the figure the employer's (review of f1120410).
  for (const prior of [OFFER, null]) {
    offerIs(prior, "The offer, at the market rate of $26/hour, is fine. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "Their offer, above the market average: $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They offered a raise, to the market median of $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They offered, in line with the market $26/hour. Draft a counter at $30/hour", 26, 30);
  }
  offerIs(OFFER, "Their $26/hour offer, the market average is $28/hour. Draft a counter at $30/hour", 26, 30);
  offerIs(OFFER, "Their $26/hour offer, though the market average is $28/hour. Draft a counter at $30/hour", 26, 30);
  keep("Glassdoor shows us competitors offer $28/hour. Draft a counter at $30/hour", 30);
  keep("We checked and the market offers $28/hour. Draft a counter at $30/hour", 30);
  // An employer who only reports what the market pays is not the subject of the offer word (Greptile on f1120410).
  keep("They said the market offers $28/hour. Draft a counter at $30/hour", 30);
  keep("They said others are paying $28/hour. Draft a counter at $30/hour", 30);
  keep("The company says the market pays $28/hour. Draft a counter at $30/hour", 30);
  keep("The recruiter told me competitors offer $28/hour. Draft a counter at $30/hour", 30);
  offerIs(OFFER, "They said they offered $26/hour because the market pays that. Draft a counter at $30/hour", 26, 30);
  offerIs(OFFER, "They told me the offer is $26/hour. Draft a counter at $30/hour", 26, 30);
  offerIs(OFFER, "They said the offer is $26/hour. Draft a counter at $30/hour", 26, 30);
  // Bare plural employers are other employers (review of 32c35b74).
  keep("Looking at the market average, employers offer $28/hour. Draft a counter at $30/hour", 30);
  keep("Employers offer $28/hour. Draft a counter at $30/hour", 30);
  keep("Other places pay $28/hour. Draft a counter at $30/hour", 30);
  // Greptile on 32c35b74: a longer description between an earlier figure and its offer word, and a pasted employer reply in
  // the first person ("we have a market-rate offer of $26/hour").
  offerIs(OFFER, "Their $26/hour starting customer support role offer, the market average is $28/hour. Draft a counter at $30/hour", 26, 30);
  offerIs(OFFER, "Their $26/hour offer and the market pays $28/hour. Draft a counter at $30/hour", 26, 30);
  for (const prior of [OFFER, null]) {
    offerIs(prior, "We have a market-rate offer of $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "We are offering $26/hour. Draft a counter at $30/hour", 26, 30);
  }
  // The offer word itself decides (review of ca432b99): a market word in front of the NOUN describes the employer's offer; a
  // third party is the source only as the subject of the VERB, or as a statistical word right before the noun.
  for (const prior of [OFFER, null]) {
    offerIs(prior, "They said the market-rate offer is $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "The recruiter said an industry-standard offer of $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "HR told me the market-adjusted offer is $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They said market conditions forced an offer of $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "The recruiter said companies like ours offer $26/hour. Draft a counter at $30/hour", 26, 30);
    offerIs(prior, "They said their market offer is $26/hour. Draft a counter at $30/hour", 26, 30);
  }
  keep("Most places near the market median offer $28/hour. Draft a counter at $30/hour", 30);
  keep("At the market level, typical offers are $28/hour. Draft a counter at $30/hour", 30);
  for (const msg of ["Competitors offer $28/hour.", "Others offer $28/hour.", "The median offer is $28/hour.", "The industry offers $28/hour.", "Payscale says the average pay is $28/hour."]) {
    keep(`${msg} Draft a counter at $30/hour`, 30);
  }
});

// The same shape at scale: 5 asks x 6 offer phrasings x 2 orders x 3 market remarks x 3 figure sets x (offer on record or not)
// = 1,080 turns. Every one saves the stated offer and the ask, thanks for the stated offer, never the market figure, sends nothing.
// (At 1419359c, 660 of these were wrong.)
Deno.test("CDW same-clause battery: ask and offer in one message, 1,080 turns: the stated offer every time; with a market figure in the sentence, held for the brain", () => {
  const asks = ["Draft a counter at $A/hour", "Write the counter at $A an hour", "Draft the counter email asking $A/hour", "Counter at $A per hour", "Draft a counter proposing $A/hr"];
  const links = ["against their $O/hour offer", "against their new $O/hour offer", "to their $O an hour offer", "vs their $O/hour offer", "versus the $O/hour they offered", "over their offered $O/hour"];
  const orders = [(a: string, l: string) => `${a} ${l}`, (a: string, l: string) => `${l.replace(/^(against|to|vs|versus|over) /, "Given ")}, ${a[0].toLowerCase() + a.slice(1)}`];
  const market = ["", " even though the market offers $M/hour", ", the market average is $M/hour"];
  const wrong: string[] = [];
  let total = 0;
  for (const prior of [OFFER, null]) for (const a of asks) for (const l of links) for (const o of orders) for (const m of market) for (const [A, O, M] of [[30, 26, 28], [32, 27, 29], [35, 28, 31]]) {
    const msg = (o(a, l) + m).replace(/\$A/g, "$" + A).replace(/\$O/g, "$" + O).replace(/\$M/g, "$" + M);
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const r = host.runTurn(msg, ctx);
    total++;
    const rec = recorded(ctx), body = String(r.result?.draft?.body ?? "");
    if (namesThird(msg)) { if (![prior ? 24 : null, null].includes(rec.hourly) || rec.counter !== null || body || !(r.result?.counterAmbiguous === true || ASKS.includes(r.intent)) || (r.result?.sends ?? 0) !== 0) wrong.push(`HELD ${prior ? "P" : "-"} ${msg} => offer ${rec.hourly}, ask ${rec.counter}`);
      else { const c2 = fresh(); if (prior) host.runTurn(prior, c2); const d = stagedDecision({ env: STAGED, message: msg, ctx: c2, host, structured: false }); if (!d.brain) wrong.push(`STAGED ${prior ? "P" : "-"} ${msg} => ${d.reason}`); }
      continue; }
    if (rec.hourly !== O || rec.counter !== A || !body.includes(`Thank you for the offer — $${O} an hour`) || (r.result?.sends ?? 0) !== 0) wrong.push(`${prior ? "P" : "-"} ${msg} => offer ${rec.hourly}, ask ${rec.counter}`);
  }
  eq(total, 1080);
  eq(wrong.slice(0, 10), [], `${wrong.length} wrong`);
});

// Who a figure belongs to, at scale: 5 reporting prefixes x 3 asks x (18 employer phrasings that must become the offer + 13
// third-party phrasings that must never replace it) = 465 turns (review rounds on #557; 150 were wrong at 1419359c).
Deno.test("CDW attribution battery, 465 turns: the employer's own figure becomes the offer; any figure in a sentence naming a third party is held for the brain, never saved", () => {
  const reporters = ["", "they said ", "the recruiter told me ", "HR mentioned that ", "I heard "];
  // employer's own figure: must become the offer (26)
  const employer = [
    "they offered $X/hour", "the company offered $X/hour", "the recruiter offered $X/hour", "they are offering $X/hour", "we are offering $X/hour",
    "they came back with $X/hour", "their offer is $X/hour", "the offer is $X/hour", "they offered a market-rate $X/hour", "they offered a below market $X/hour",
    "they made a market-rate offer of $X/hour", "their industry-standard offer is $X/hour", "the market-adjusted offer is $X/hour", "they offer the market rate of $X/hour",
    "we have a market-rate offer of $X/hour", "the company's average offer is $X/hour", "their offer, at the market rate, is $X/hour", "companies like ours offer $X/hour",
  ];
  // third party's figure: must never become the offer (recorded 24 stays)
  const third = [
    "the market offers $X/hour", "the market pays $X/hour", "competitors offer $X/hour", "others are paying $X/hour", "employers offer $X/hour", "most places offer $X/hour",
    "the industry pays $X/hour", "glassdoor says others pay $X/hour", "the median offer is $X/hour", "the average pay is $X/hour", "typical offers are $X/hour",
    "other companies pay $X/hour", "competitors are now offering $X/hour",
  ];
  const asks = [". Draft a counter at $30/hour", ", draft a counter at $30/hour", ". Write the counter at $30 an hour"];
  let total = 0;
  const wrong: string[] = [];
  for (const r of reporters) for (const a of asks) {
    for (const e of employer) {
      const msg = (r + e).replace("$X", "$26") + a; const m = msg[0].toUpperCase() + msg.slice(1);
      const ctx = fresh(); host.runTurn("They offered me $24/hour for the warehouse job.", ctx); const res = host.runTurn(m, ctx); total++;
      const th = ctx.negotiationThread ?? {};
      if (namesThird(m)) { if ((th.hourly ?? null) !== 24 || th.counter?.hourly != null || res?.result?.draft?.body || res?.result?.counterAmbiguous !== true || (res?.result?.sends ?? 0) !== 0) wrong.push(`HELD ${m} => offer=${th.hourly} counter=${th.counter?.hourly}`); continue; }
      if (th.hourly !== 26 || th.counter?.hourly !== 30 || (res?.result?.sends ?? 0) !== 0) wrong.push(`EMP ${m} => offer=${th.hourly} counter=${th.counter?.hourly}`);
    }
    for (const t of third) {
      const msg = (r + t).replace("$X", "$28") + a; const m = msg[0].toUpperCase() + msg.slice(1);
      const ctx = fresh(); host.runTurn("They offered me $24/hour for the warehouse job.", ctx); const res = host.runTurn(m, ctx); total++;
      const th = ctx.negotiationThread ?? {};
      if (namesThird(m)) { if ((th.hourly ?? null) !== 24 || th.counter?.hourly != null || res?.result?.draft?.body || res?.result?.counterAmbiguous !== true || (res?.result?.sends ?? 0) !== 0) wrong.push(`HELD ${m} => offer=${th.hourly} counter=${th.counter?.hourly}`); continue; }
      if (th.hourly !== 24 || th.counter?.hourly !== 30 || (res?.result?.sends ?? 0) !== 0) wrong.push(`3RD ${m} => offer=${th.hourly} counter=${th.counter?.hourly}`);
    }
  }
  eq(total, 465);
  eq(wrong.slice(0, 10), [], `${wrong.length} wrong`);
});

// Review of bfc4c9d3 and Greptile on ca432b99: every one of these names a third party in the figure's sentence. Code does not
// attribute the figure: nothing saved, no draft (never a silent draft with the stale $24), and staged mode hands it to the brain.
Deno.test("CDW market exit: a third party in the figure's sentence holds the turn for the brain, with or without an offer on record", () => {
  const rows = [
    "They offered what the market pays: $26/hour", "They're paying what the industry pays — $26/hour", "Indeed offered me $26/hour", "Glassdoor offered me $26/hour",
    "They're offering the typical offer: $26/hour", "The median offer they made was $26/hour", "The market offer letter says $26/hour",
    "Competitors are hiring and paying $28/hour", "Both companies offered me $26/hour", "They offered a below market rate of $26/hour",
  ];
  for (const prior of [OFFER, null]) for (const row of rows) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    const r = host.runTurn(msg, ctx);
    heldForBrain(ctx, r, before, msg);
    const d = stagedDecision({ env: STAGED as any, message: msg, ctx: (() => { const c = fresh(); if (prior) host.runTurn(prior, c); return c; })(), host, structured: false });
    eq(d.brain, true, `${msg}: staged goes to the brain (${d.reason})`);
    if (r.result?.counterAmbiguous) eq(d.reason, "counter_ambiguous_figures", msg);
  }
  // A market remark in another sentence does not hold the turn; a plain offer still drafts.
  const ctx = fresh(); host.runTurn(OFFER, ctx);
  const r = host.runTurn("They came back with $26/hour. The market is tight. Draft a counter at $30/hour", ctx);
  eq([recorded(ctx).hourly, recorded(ctx).counter], [26, 30]);
  assert(/Thank you for the offer — \$26 an hour/.test(String(r.result?.draft?.body ?? "")));
});

// Review of 201c435c: the market exit covers every unit (a third party's bonus or annual figure is not the employer's), a held
// turn records no bonus or amount from the message, decimals do not split sentences, and incidental words do not hold.
Deno.test("CDW market exit, every unit: a third party's bonus or salary is never saved; incidental words do not hold the turn", () => {
  const run = (prior: string | null, msg: string) => { const ctx = fresh(); if (prior) host.runTurn(prior, ctx); const r = host.runTurn(msg, ctx); return { ctx, r, th: ctx.negotiationThread ?? {} }; };
  for (const prior of [OFFER, null]) {
    for (const msg of [
      "Competitors offer a $5,000 signing bonus. Draft a counter at $30/hour",
      "Competitors offer a $5k signing bonus. Draft a counter at $30/hour",
      "The market pays $60k a year and they offered $55k. Draft a counter at $30/hour",
    ]) {
      const { ctx, r, th } = run(prior, msg);
      eq([th.signing ?? null, th.amount ?? ctx.offer?.amount ?? null], [null, null], `${msg}: no bonus or amount recorded`);
      assert(!r.result?.draft?.body && r.result?.counterAmbiguous === true && (r.result?.sends ?? 0) === 0, `${msg}: held`);
      eq(recorded(ctx).hourly, prior ? 24 : null, `${msg}: offer unchanged`);
    }
  }
  // a decimal in an earlier figure does not cut the sentence: the market word still shares it
  const d = run(OFFER, "Per the market average I'd ask for $29.50/hour but they offered $28/hour. Draft a counter at $30/hour");
  assert(!d.r.result?.draft?.body && recorded(d.ctx).hourly === 24, "decimal: held, $24 stays");
  // incidental words name no third party: the plain offer still saves and drafts
  for (const [msg, offer] of [
    ["They offered $26/hour for a market research role. Draft a counter at $30/hour", 26],
    ["They offered $26 an hour plus a $2,000 signing bonus. Draft a counter at $30/hour", 26],
  ] as const) {
    const { ctx, r } = run(OFFER, msg);
    eq(recorded(ctx).hourly, offer, msg);
    assert(new RegExp(`Thank you for the offer — \\$${offer} an hour`).test(String(r.result?.draft?.body ?? "")), `${msg}: drafted`);
  }
  const b = run(OFFER, "They offered $26 an hour plus a $2,000 signing bonus. Draft a counter at $30/hour");
  eq(b.th.signing, 2000, "the employer's own bonus is still recorded");
});

// Review of 77c02aad: a cited source is a third party even in a compound ("market data", "market intelligence", "stock market
// jobs") or after a comma ("Indeed, similar jobs offer"); only an auxiliary "indeed" and a role/team name ("a market research
// role") are incidental.
Deno.test("CDW market exit: cited sources hold the turn; only an auxiliary 'indeed' and a market role name are incidental", () => {
  for (const prior of [OFFER, null]) for (const row of [
    "Market data puts offers at $28/hour", "On Indeed, similar jobs offer $28/hour", "Indeed, similar jobs offer $28/hour",
    "Per market intelligence, roles like this offer $28/hour", "Stock market jobs offer $28/hour", "Similar roles offer $28/hour",
  ]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
});

// Review of 76313b47: a market role name is incidental only as one named role ("a/the market research analyst role"); plural
// generic roles ("market research analyst positions usually offer $28/hour") are a market claim and hold the turn.
Deno.test("CDW market exit: a named market role is the employer's; plural market roles are a market claim", () => {
  for (const prior of [OFFER, null]) for (const row of ["Market research analyst positions usually offer $28/hour", "Market research analyst jobs offer $28/hour"]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
  for (const msg of ["They offered me a market research analyst role at $26/hour. Draft a counter at $30/hour", "The market research analyst role offers $26/hour. Draft a counter at $30/hour"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    eq(recorded(ctx).hourly, 26, msg);
    assert(/Thank you for the offer — \$26 an hour/.test(String(r.result?.draft?.body ?? "")), `${msg}: drafted`);
  }
});

// Greptile on 76313b47: "indeed" is never treated as an adverb; the salary site and the adverb cannot be told apart, so the turn
// is held (an extra question, never a wrong offer).
Deno.test("CDW market exit: any 'indeed' in the figure's sentence holds the turn", () => {
  for (const prior of [OFFER, null]) for (const row of ["It was Indeed that quoted $28/hour", "They did indeed offer $26/hour", "Indeed quoted $28/hour"]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
});

// Greptile on c77cbd78: a named market job title of up to three words is the employer's role ("a market data engineer role");
// pay, statistics and reporting words inside it are not a title ("the market rate for this role" still holds).
Deno.test("CDW market exit: a named market job title is the employer's role; a market rate phrased around a role still holds", () => {
  for (const msg of [
    "They offered $26/hour for a market data engineer role. Draft a counter at $30/hour",
    "They offered me a market access lead position at $26/hour. Draft a counter at $30/hour",
    "They offered $26/hour for the market research analyst role. Draft a counter at $30/hour",
  ]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    eq(recorded(ctx).hourly, 26, msg);
    assert(/Thank you for the offer — \$26 an hour/.test(String(r.result?.draft?.body ?? "")), `${msg}: drafted`);
  }
  for (const prior of [OFFER, null]) for (const row of [
    "The market rate for this role is $28/hour", "The market pay for a data engineer role is $28/hour", "The market average for this job is $28/hour",
  ]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
});

// Review of 1275f3d5: the job title is an allowlist (market + research/data/analytics/access/making/insights/intelligence and/or a
// job noun + a singular role noun). Comparison and benchmark words are never a title, and "elsewhere" is a third party.
Deno.test("CDW market exit: market comparisons are never a job title; 'elsewhere' is a third party", () => {
  for (const prior of [OFFER, null]) for (const row of [
    "The market equivalent role pays $28/hour", "The market equivalent role offers $28/hour", "The market comparable position pays $28/hour",
    "The market benchmark job pays $28/hour", "The market entry-level job pays $28/hour", "A market data engineer role elsewhere pays $28/hour",
  ]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
  for (const msg of ["Their market data engineer role offers $26/hour. Draft a counter at $30/hour", "They offered $26/hour for a market data engineer role. Draft a counter at $30/hour"]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    host.runTurn(msg, ctx);
    eq(recorded(ctx).hourly, 26, msg);
  }
});

// Greptile on #564: a dot inside a site name is not a sentence end, so "Salary.com says they offer $28/hour" keeps its source.
Deno.test("CDW market exit: salary-site names with a dot stay in the figure's sentence", () => {
  for (const prior of [OFFER, null]) for (const row of [
    "Salary.com says they offer $28/hour", "Levels.fyi shows $28/hour for this role", "On glassdoor.com they pay $28/hour", "Per salary.com the offer is $28/hour",
    "Competitors, e.g. Acme, offer $28/hour", "The market in the U.S. pays $28/hour",
    // An abbreviation that may close a sentence ("U.S.", "Inc.") is not split: the words after it usually point back to the third
    // party it names ("Competitors in the U.S. They offer..."), so a figure there is held for the brain to ask (review of e4b4e392).
    // Greptile's "...strong in the U.S. They offered $26/hour" is held on purpose: one question, never a wrong save (D-007).
    "Competitors in the U.S. They offer $28/hour", "Competitors in the U.S. The offers there are $28/hour",
    "other companies like Acme Inc. Their offer is $28/hour", "Glassdoor lists Acme Inc. The offer there is $28/hour",
    "The market rate per Acme Inc. The offer is $28/hour", "The market is strong in the U.S. They offered $26/hour",
    "I checked the job market in the U.S. They offered $26/hour",
    // "no." before a number keeps the source in the sentence (Greptile on #565)
    "Salary.com report no. 5 says they offer $28/hour", "The market survey No. 12 shows they offer $28/hour",
  ]) {
    const msg = `${row}. Draft a counter at $30/hour`;
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = recorded(ctx).hourly;
    heldForBrain(ctx, host.runTurn(msg, ctx), before, msg);
  }
  // a real sentence end still separates a market remark from the offer (C04-style)
  const ctx = fresh(); host.runTurn(OFFER, ctx);
  host.runTurn("They came back with $26/hour. I checked salary.com later. Draft a counter at $30/hour", ctx);
  eq(recorded(ctx).hourly, 26);
  // a period before a closing quote or bracket still ends the sentence (Greptile on #565)
  for (const msg of ['He said "the market is tight." They offered $26/hour. Draft a counter at $30/hour', "The market said no. They offered $26/hour. Draft a counter at $30/hour",
                     "(The market is tight.) They offered $26/hour. Draft a counter at $30/hour"]) {
    const c2 = fresh(); host.runTurn(OFFER, c2);
    const r = host.runTurn(msg, c2);
    eq(recorded(c2).hourly, 26, msg);
    assert(/Thank you for the offer — \$26 an hour/.test(String(r.result?.draft?.body ?? "")), `${msg}: drafted`);
  }
});

// Greptile on #570: an offer-detail statement whose figures are held (a pay figure beside a third party) recorded the
// third party's "$NNk" as the offer through the old fallback, and said "Offer updated". A held statement records nothing:
// no stated figure, no hourly rate, no bonus, no thread amount, and no "Offer updated" reply.
Deno.test("CDW held offer details record no figure, on a fresh thread and with an offer on record", () => {
  for (const prior of [null, OFFER]) for (const msg of [
    "The offer is $30/hour, but competitors offer $60k", "The offer is $30/hour. Competitors offer $60k.",
    "They offered $30/hour and the market average is $65k", "The offer is $30/hour, Glassdoor says $70k for this role",
  ]) {
    const ctx = fresh();
    if (prior) host.runTurn(prior, ctx);
    const before = JSON.stringify({ o: ctx.offer ?? null, a: (ctx as any).negotiationThread?.amount ?? null });
    const r = host.runTurn(msg, ctx);
    const o: any = ctx.offer ?? {};
    for (const v of [o.stated_figure, o.base_salary, (ctx as any).negotiationThread?.amount]) assert(!/60|65|70/.test(String(v ?? "")) || before.includes(String(v)), `${prior ? "prior" : "fresh"} ${msg}: third-party figure saved (${JSON.stringify(o)})`);
    assert(!/Offer updated/.test(String(r.reply ?? "")), `${prior ? "prior" : "fresh"} ${msg}: said "Offer updated"`);
    eq(r.result?.sends ?? 0, 0, msg);
  }
  // a plain offer still records
  const c = fresh(); host.runTurn("The offer is $60k", c); eq((c.offer as any)?.stated_figure, "$60,000");
  const c2 = fresh(); host.runTurn("They offered me $70k with a $5k signing bonus", c2); eq((c2.offer as any)?.signing_bonus, 5000);
});

// Greptile on #574: a counter revision whose figures are held (a third party's pay beside the new ask) revises nothing.
Deno.test("CDW held counter revisions record no counter; plain revisions still revise", () => {
  for (const msg of ["The market offers $28/hour; make it $30/hour instead", "Competitors pay $29/hour, make it $31/hour", "Glassdoor says $28/hour. make it $30/hour"]) {
    const ctx = fresh(); host.runTurn(OFFER, ctx); host.runTurn("Draft a counter at $27/hour", ctx);
    const r = host.runTurn(msg, ctx);
    eq(recorded(ctx).counter, 27, `${msg}: counter unchanged`);
    eq(r.result?.sends ?? 0, 0, msg);
  }
  const c = fresh(); host.runTurn(OFFER, c); host.runTurn("Draft a counter at $27/hour", c); host.runTurn("make it $30/hour instead", c);
  eq(recorded(c).counter, 30, "plain revision");
});

// Review on #575: a held revision carries the figures without roles, so the staged brain asks which one is the new ask.
Deno.test("CDW a held counter revision hands the brain the figures and asks for the new ask", () => {
  for (const msg of ["The market offers $28/hour; make it $30/hour instead", "make it $30/hour, the market pays $28/hour"]) {
    const ctx = fresh(); host.runTurn(OFFER, ctx); host.runTurn("Draft a counter at $27/hour", ctx);
    const d = stagedDecision({ env: STAGED, message: msg, ctx, host, structured: false });
    eq(d.brain, true, `${msg}: brain`); eq(d.reason, "counter_ambiguous_figures", msg); eq(d.ambiguousRole, "ask", msg);
    const vals = (d.ambiguousFigures ?? []).map((f) => f.value).sort();
    eq(JSON.stringify(vals), JSON.stringify([28, 30]), `${msg}: figures`);
    assert(/new counter ask/.test(routerAnswerBlock(d)), msg);
    const r = host.runTurn(msg, ctx);
    eq(recorded(ctx).counter, 27, `${msg}: counter unchanged`); eq(r.result?.counterAmbiguous, true, msg); eq(r.result?.sends ?? 0, 0, msg);
  }
});

// Greptile records 29 and 35: a unitless ask the router cannot read never lets an older saved counter stand in for it.
Deno.test("CDW a cued unitless ask that is not read keeps the slot blank and never reuses a stale counter", () => {
  for (const msg of ["Draft a counter at $28 with no relocation allowance", "Draft a counter at $28 for a childcare role"]) {
    for (const prior of [null, "Counter at $26/hour"]) {
      const ctx = fresh(); host.runTurn(OFFER, ctx); if (prior) host.runTurn(prior, ctx);
      const r = host.runTurn(msg, ctx);
      const draft = String(r.result?.draft?.body ?? r.reply ?? "");
      assert(!/meet me at \$26/.test(draft), `${msg} / ${prior}: stale $26 reused: ${draft.slice(0, 300)}`);
      assert(/\$28/.test(String(r.reply)), `${msg} / ${prior}: asks about $28: ${String(r.reply).slice(-200)}`);
      eq(r.result?.sends ?? 0, 0, msg);
    }
  }
  // No figure this turn: the saved counter is still the draft's ask.
  const c = fresh(); host.runTurn(OFFER, c); host.runTurn("Counter at $26/hour", c);
  assert(/meet me at \$26/.test(String(host.runTurn("Draft the counter email", c).result?.draft?.body)), "saved counter reused when no figure is given");
});

// Review of #575 (inventory record 55's rule): a held revision carries structured state only, no clarification prose of its own.
Deno.test("CDW a held counter revision adds no prose of its own", () => {
  const ctx = fresh(); host.runTurn(OFFER, ctx); host.runTurn("Draft a counter at $27/hour", ctx);
  const r = host.runTurn("The market offers $28/hour; make it $30/hour instead", ctx);
  assert(!/which figure is your new counter|couldn't tell whether/i.test(String(r.reply)), String(r.reply));
  eq(r.result?.counterAmbiguous, true, "held"); eq(r.result?.draft, undefined, "no draft"); eq(recorded(ctx).counter, 27, "counter unchanged");
});

// Greptile record 90: a third party's figure holds the turn also when it equals the recorded offer.
// Review of #575: the brain's figures keep their thousands ("$65k" is 65000, not 65).
Deno.test("CDW a third party's figure equal to the recorded offer still holds; held figures keep their thousands", () => {
  const ctx = fresh(); host.runTurn(OFFER, ctx);
  const d = stagedDecision({ env: STAGED, message: "Competitors offer $24/hour. Draft a counter at $30/hour", ctx, host, structured: false });
  eq(d.brain, true, "held for the brain"); eq(d.reason, "counter_ambiguous_figures", "reason");
  const r = host.runTurn("Competitors offer $24/hour. Draft a counter at $30/hour", ctx);
  eq(recorded(ctx).counter ?? null, null, "no counter saved"); eq(r.result?.draft, undefined, "no draft");
  const c = fresh(); host.runTurn(OFFER, c); host.runTurn("Draft a counter at $27/hour", c);
  const k = stagedDecision({ env: STAGED, message: "make it $65k; the market pays $60k", ctx: c, host, structured: false });
  eq(JSON.stringify((k.ambiguousFigures ?? []).map((f) => f.value).sort()), JSON.stringify([60000, 65000]), "thousands kept");
});

// Greptile record 94: a held offer detail reaches the brain with its figures, and the brain asks which one is the new offer.
Deno.test("CDW a held offer detail hands the brain its figures (counter_ambiguous_figures)", () => {
  for (const prior of [null, OFFER]) for (const msg of ["The offer is $30/hour, but competitors offer $60k", "The offer is $30/hour. Competitors offer $60k.",
    "They offered $30/hour and the market average is $65k", "The offer is $30/hour, Glassdoor says $70k for this role"]) {
    const ctx = fresh(); if (prior) host.runTurn(prior, ctx);
    const d = stagedDecision({ env: STAGED, message: msg, ctx, host, structured: false });
    eq(d.brain, true, `${prior ? "prior" : "fresh"} ${msg}: brain`); eq(d.reason, "counter_ambiguous_figures", `${prior ? "prior" : "fresh"} ${msg}: reason`);
    assert((d.ambiguousFigures ?? []).some((f) => f.value === 30) && (d.ambiguousFigures ?? []).some((f) => f.value >= 60000), `${msg}: ${JSON.stringify(d.ambiguousFigures)}`);
    assert(/new offer/.test(routerAnswerBlock(d)), msg);
  }
});

// Review of f62e2033: a friend's or coworker's pay is a third party's figure; a held turn keeps the standing offer whole; a cued
// figure that is not an hourly ask never blanks the saved counter or gets an hour unit.
Deno.test("CDW third-party people hold the turn and the standing offer stays; cued figures need an hourly shape", () => {
  for (const msg of ["My friend at Acme was offered $35/hour. Draft a counter at $30/hour", "They offered me $30/hour and my coworker makes $34/hour"]) {
    const ctx = fresh(); host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    eq(recorded(ctx).offer ?? (ctx as any).negotiationThread?.hourly, 24, `${msg}: offer stays 24`);
    eq((ctx.offer as any)?.hourly_rate, 24, `${msg}: ctx offer stays 24`);
    eq(r.result?.sends ?? 0, 0, msg);
    eq(stagedDecision({ env: STAGED, message: msg, ctx, host, structured: false }).reason, "counter_ambiguous_figures", msg);
  }
  const c = fresh(); host.runTurn(OFFER, c); host.runTurn("Counter at $26/hour", c);
  assert(/meet me at \$26/.test(String(host.runTurn("Draft the counter email; I want to mention the $5 shift differential", c).result?.draft?.body)), "saved counter kept");
  const k = fresh(); host.runTurn(OFFER, k);
  assert(!/\$70,000 an hour/.test(String(host.runTurn("Draft a counter asking for $70,000", k).reply)), "no hourly unit on $70,000");
});

// Review of f609ce7d: another person's pay holds only when that person is tied to the figure; peer roles, sister companies and
// referrals are offers. A cued figure that is an add-on or out of an hourly range is never asked about as an hourly ask, and
// never blanks the saved counter.
Deno.test("CDW person words hold only another person's pay; add-ons and out-of-range figures keep the saved counter", () => {
  for (const [msg, v] of [["I got an offer of $30/hour for a peer support specialist role", 30], ["I got an offer of $25/hour for a peer mentor role.", 25], ["A friend referred me and they offered $30/hour", 30],
    ["Acme offered me $30/hour after my colleague referred me", 30], ["My former coworker is the hiring manager and she offered me $28/hour", 28], ["I got an offer from a sister company for $30/hour", 30],
    ["The hiring manager offered me $30/hour", 30]] as [string, number][]) {
    const c = fresh(); host.runTurn(msg, c);
    eq((c.offer as any)?.hourly_rate, v, `${msg}: offer recorded`);
  }
  for (const msg of ["Draft the counter; ask for $500 relocation", "Draft the counter; ask for $5 more for night shifts", "Draft the counter; ask for $2 more", "Draft the counter at $120"]) {
    const c = fresh(); host.runTurn(OFFER, c); host.runTurn("Counter at $26/hour", c);
    const r = host.runTurn(msg, c);
    assert(!/Is \$\d[\d,]* an hour the rate/.test(String(r.reply)), `${msg}: ${String(r.reply).slice(-120)}`);
    assert(/meet me at \$26/.test(String(r.result?.draft?.body)), `${msg}: saved counter kept`);
  }
  const e = fresh(); host.runTurn("The market offers $28/hour; make it $30/hour", e);
  eq((e as any).negotiationThread, undefined, "a held turn leaves no empty thread behind");
});

// Review of 529d1d08: a first-person offer after a referral or a thank-you is the user's own ("I got offered", "got me an offer").
Deno.test("CDW first-person offers after a person word are recorded", () => {
  for (const [msg, field, v] of [["My friend referred me and I got offered $32/hour", "hourly_rate", 32], ["My colleague introduced me and I was offered $31/hour", "hourly_rate", 31],
    ["Thanks to my friend I got an offer of $30/hour from Acme", "hourly_rate", 30], ["My friend at Acme got me an offer of $30/hour", "hourly_rate", 30],
    ["As a people ops lead I got offered $45/hour", "hourly_rate", 45]] as [string, string, number][]) {
    const c = fresh(); host.runTurn(msg, c);
    eq((c.offer as any)?.[field], v, `${msg}: offer recorded`);
  }
  const c = fresh(); host.runTurn("My cousin referred me and I got an offer of $85,000 from Acme", c);
  assert([(c.offer as any)?.base_salary, (c as any).negotiationThread?.amount].includes(85000), "annual offer recorded");
});
