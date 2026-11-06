// G3 (Greptile P1 on PR #549): with a $24/hour offer on record, "Draft the counter email at $28/hour" was parsed as a NEW
// offer of $28 (the wording matched no ask cue), replacing the recorded $24; the draft thanked the employer for a $28 offer.
// The recorded offer stays unless the message REPORTS a new one; a figure in a counter-drafting request is the ASK.
// Final draft text AND saved thread/offer state, through the host's runTurn. Memory stores, fixed clock, no model, no network.
//   deno test -A --no-check tests/architect/counter-draft-wording-20261106.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

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
