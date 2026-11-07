// Pre-release review of d3fd6027 (reviewer C): with $24/hour on record, a competing offer must not replace the first employer
// figure, and another person's pay written as a possessive or by a family member is held, never saved or drafted (D-007).
//   deno test -A --no-check tests/architect/r8-prerelease-counter-20261107.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-r8p", threadId: "t-r8p", now: Date.UTC(2026, 10, 7, 15), snapshot: null, accountPersistence: true });
const OFFER = "I got an offer of $24/hour for a support role.";
const hourly = (ctx: any) => ctx.negotiationThread?.hourly ?? null;

Deno.test("R8P-1 a second employer figure does not replace the first", () => {
  const ctx = fresh(); host.runTurn(OFFER, ctx);
  host.runTurn("They offered me $26/hour but my other offer is $30/hour", ctx);
  assertNode.notEqual(hourly(ctx), 30, "the competing $30 is not the offer");
  const r = host.runTurn("Draft a counter at $32/hour", ctx);
  assertNode.ok(!/offer[^.]{0,20}\$30 an hour/.test(String(r.result?.draft?.body ?? "")), "the draft does not thank for $30");
});

Deno.test("R8P-2 another person's pay is held: possessives and family members", () => {
  for (const msg of ["My friend's offer was $30/hour. Draft a counter at $28/hour", "My coworker's offer was $30/hour", "My sister's offer was $30/hour",
    "My husband was offered $30/hour there", "My wife got offered $30/hour there", "My friends’ pay is $30/hour"]) {
    const ctx = fresh(); host.runTurn(OFFER, ctx);
    const r = host.runTurn(msg, ctx);
    assertNode.equal(hourly(ctx), 24, `${msg}: the offer stays 24`);
    assertNode.ok(!/\$30 an hour/.test(String(r.result?.draft?.body ?? "")), `${msg}: no draft thanks for $30`);
  }
});

Deno.test("R8P-3 the person's own offer is still recorded", () => {
  for (const [msg, want] of [["They offered me $27/hour", 27], ["My friend referred me and they offered $28/hour", 28], ["Acme offered me $29/hour, my partner thinks that's fair", 29]] as const) {
    const ctx = fresh(); host.runTurn(OFFER, ctx); host.runTurn(msg, ctx);
    assertNode.equal(hourly(ctx), want, msg);
  }
});
