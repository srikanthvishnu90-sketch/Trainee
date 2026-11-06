// Greptile P1 on release PR #549 (2026-11-06): with a $24/hour offer on record, "Draft the counter email at $28/hour" took $28 for
// the OFFER (the wording is not one of parseOfferFigures' ask cues), so the draft thanked the employer for a $28 offer, the recorded
// $24 was replaced as the base, and the ask was dropped (a counter at or below the "offer" is no counter). The recorded offer stays
// unless the message reports a new one ("they offered", "the offer is now", "they came back with"); draft-rate wording ("counter at
// $28", "ask for $28", "draft ... at $28") is the ask. Held, sends 0.
// Memory stores, fixed clock, no model, no network.   deno test -A --no-check tests/architect/counter-draft-rate-20261106.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-dr", threadId: "t-dr", now: Date.UTC(2026, 10, 6, 15), snapshot: null, accountPersistence: true });
const ask = (b: string) => b.match(/meet me at[^?]*\?/)?.[0] ?? "";
const OFFER = "I got an offer of $24/hour for a support role. Draft the counter email.";

Deno.test("DR-1 with $24/hour on record, draft-rate wording names the ASK; the offer restated stays $24", () => {
  for (const m of ["Draft the counter email at $28/hour", "Draft the email at $28/hour.", "Write the counter at $28 an hour", "Counter at $28/hour", "Draft the counter email, ask for $28/hour."]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const r = host.runTurn(m, ctx);
    eq(r.intent, "negotiation_draft", m);
    const body: string = r.result.draft.body;
    assert(/Thank you for the offer — \$24 an hour/.test(body), `${m}: the offer is restated as $24: ${body.slice(0, 300)}`);
    assert(!/offer — \$28/.test(body), `${m}: never thanks them for a $28 offer`);
    assert(/meet me at \$28 an hour\?/.test(body), `${m}: the ask is $28: ${ask(body)}`);
    eq(r.result.sends, 0, m);
    // The next turn still drafts the $28 ask against the $24 offer (the ask was recorded, the offer was not replaced).
    const next = host.runTurn("Draft the counter email.", ctx).result.draft.body as string;
    assert(/Thank you for the offer — \$24 an hour/.test(next) && /meet me at \$28 an hour\?/.test(next), `${m}: next turn: ${next.slice(0, 400)}`);
  }
});

Deno.test("DR-2 a message that reports a NEW offer replaces the recorded one", () => {
  for (const m of ["They came back with $26/hour. Draft the counter email at $29/hour.", "The offer is now $26/hour. Draft the counter email, counter at $29/hour.", "They offered $26/hour. Draft a counter, ask for $29/hour."]) {
    const ctx = fresh();
    host.runTurn(OFFER, ctx);
    const body: string = host.runTurn(m, ctx).result.draft.body;
    assert(/Thank you for the offer — \$26 an hour/.test(body), `${m}: the new offer: ${body.slice(0, 300)}`);
    assert(/meet me at \$29 an hour\?/.test(body), `${m}: the ask: ${ask(body)}`);
  }
});
