// ROUTING SCENARIOS, pure (architect, 2026-10-29): 10,000 generated phrasings across the families that must never cross,
// each routed by the turns' own predicates in the handler's gate order (tests/architect/routing-scenarios.ts pureRoute; no
// database, no model, no network). A strict phrasing (case, end punctuation, extra spaces) must take exactly its turn;
// a noisy one (a greeting, "please", "thanks", an emoji, one or two typos, a question mark) its family's turn or the
// router, never another family's turn. Two asks in one message are never acted on. The misroutes this found on trunk
// (2026-10-29) are pinned below by name, each at the predicate that was wrong.
import assertNode from "node:assert/strict";
import { FAMILY_ROUTES, pureRoute, type Route, scenarios, world } from "./routing-scenarios.ts";
import { parsePeopleAsk } from "../../supabase/functions/_shared/career_people.ts";
import { parseTargetAsk } from "../../supabase/functions/_shared/career_people_provider.ts";
import { forgetAsk, parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";
import { cancelAsk } from "../../supabase/functions/_shared/career_hosted_prepare.ts";
import { applyAsk, applyManyAsk } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { linkAsk } from "../../supabase/functions/_shared/career_apply_link.ts";
import { statusAsk } from "../../supabase/functions/_shared/career_apply_status.ts";
import { standingAsk } from "../../supabase/functions/_shared/career_standing.ts";
import { emailStatusAsk } from "../../supabase/functions/_shared/career_send_rail.ts";
import { billingAsk } from "../../supabase/functions/_shared/career_billing.ts";
import { connectorAsk } from "../../supabase/functions/_shared/connectors.ts";
import { outlookAsk } from "../../supabase/functions/_shared/outlook_connector.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ACTING: Route[] = ["apply_queue", "apply_cancel", "billing"];

Deno.test("10,000 phrasings: each strict one takes exactly its turn, no noisy one crosses into another family's turn", () => {
  const all = scenarios();
  eq(all.length, 10_000, "the generator makes 10,000 distinct messages");
  const byFamily: Record<string, { n: number; strict: number; own: number; router: number }> = {};
  const misroutes: string[] = [];
  const siteNamed: Record<string, number> = {};
  for (const s of all) {
    const got = pureRoute(s.message, world);
    const f = (byFamily[s.family] ??= { n: 0, strict: 0, own: 0, router: 0 });
    f.n++; if (s.strict) f.strict++;
    if (got === "router") f.router++; else if (s.expect.includes(got)) f.own++;
    if (s.family === "site_named") siteNamed[`${s.expect[0]} -> ${got}`] = (siteNamed[`${s.expect[0]} -> ${got}`] ?? 0) + 1;
    // Reading the person's own job-alert emails (a people "jobs" ask) does nothing on the site: allowed for a noisy
    // site phrasing ("appply to jobs on Indeed"), never for a strict one.
    const ownJobEmails = !s.strict && got === "networking" && (s.family === "site" || s.family === "site_named") && parsePeopleAsk(s.message)?.kind === "jobs";
    if (!s.expect.includes(got) && !ownJobEmails) misroutes.push(`${s.strict ? "strict" : "noisy"} ${s.family} [${s.variant}] ${JSON.stringify(s.message)}: expected ${s.expect.join("|")}, got ${got}`);
    if (s.family === "multi") ok(!ACTING.includes(got), `two asks in one are never acted on: ${s.message} -> ${got}`);
  }
  console.log(JSON.stringify({ byFamily, siteNamed }, null, 1));
  eq(misroutes.slice(0, 40), [], `${misroutes.length} misroutes`);
});

Deno.test("the families never cross: billing vs application cancel, email vs application status, networking vs apply, connectors", () => {
  for (const s of scenarios()) {
    const got = pureRoute(s.message, world);
    for (const [family, never] of [["billing", ["apply_cancel", "apply_queue", "receipt"]], ["app_cancel", ["billing", "apply_queue", "networking"]],
      ["outreach_status", ["status", "apply_queue", "networking"]], ["app_status", ["outreach_status", "apply_queue", "networking"]],
      ["networking", ["apply_queue", "apply_cancel", "billing"]], ["connectors", ["apply_queue", "networking", "apply_cancel", "billing"]],
      ["apply", ["networking", "apply_cancel", "billing"]], ["app_receipts", ["billing"]]] as [string, Route[]][]) {
      if (s.family === family) ok(!never.includes(got), `${s.family} ${JSON.stringify(s.message)} -> ${got}`);
    }
    if (s.family !== "site_named" && s.family !== "multi") ok(s.expect.includes(got) || FAMILY_ROUTES[s.family].includes(got) || got === "router" || !s.strict && got === "networking" && parsePeopleAsk(s.message)?.kind === "jobs", `${s.family} ${s.message} -> ${got}`);
  }
});

// The misroutes found on trunk 2026-10-29, at the predicate that was wrong (input / expected / what trunk did).
Deno.test("fixed: 'withdraw from X' / 'remove X from my list' cancel the application; never a people search or a contact delete", () => {
  for (const [m, co] of [["withdraw from Stripe", "Stripe"], ["Withdraw from Goldman Sachs.", "Goldman Sachs"], ["remove Stripe from my list", "Stripe"],
    ["remove Acme Corp from my queue", "Acme Corp"], ["can you remove Figma from my list", "Figma"], ["remove LinkedIn from my list thanks", "LinkedIn"],
    ["hey don't apply to Stripe", "Stripe"], ["ok so do not apply to Notion.", "Notion"], ["👋 don't apply to Ramp", "Ramp"], ["remove Apply Digital from my list", "Apply Digital"]] as const) {
    eq(cancelAsk(m), co, m);
  }
  // trunk: a people search for the title "withdraw" at Stripe; for "remove stripe" at "my queue"; a forget of the contact "stripe".
  eq(parseTargetAsk("withdraw from Stripe"), null);
  eq(parseTargetAsk("remove Stripe from my queue"), null);
  eq(parseTargetAsk("aply to the data analyst role at Figma"), null);
  eq(parsePeopleAsk("remove LinkedIn from my list"), null, "never the LinkedIn export");
  ok(forgetAsk("remove Maya Chen from my contacts"), "a contact is still forgotten from the contacts");
  // Still people searches.
  for (const m of ["engineering managers at Stripe", "recruiters at Ramp", "find recruiters at Stripe", "find engineers at Notion", "recruiters or talent partners at Ramp"]) ok(parseTargetAsk(m)?.kind === "role_at", m);
  // Two asks: never a cancel of an employer named "Stripe and apply to Ramp".
  for (const m of ["withdraw from Stripe and apply to Ramp", "don't apply to Stripe, apply to Ramp", "remove Ramp from my list and apply to Notion"]) eq(cancelAsk(m), null, m);
});

Deno.test("fixed: a negation, a question behind a greeting, or a second ask is never an apply", () => {
  // trunk: each of these queued the employer.
  for (const m of ["hey don't apply to Stripe", "ok so don't apply to Notion", "pls do not apply to Billing Co.", "hey did you apply to Stripe", "pls did you apply to Notion",
    "connect gmail and apply to Stripe", "withdraw from Stripe and apply to Ramp", "who do I know at Stripe and apply to Stripe", "never apply to Ramp"]) {
    eq(applyAsk(m), null, m);
    eq(applyManyAsk(m), null, m);
  }
  eq(linkAsk("don't apply to https://boards.greenhouse.io/acme/jobs/12345"), null);
  // Still applies.
  eq(applyAsk("apply to Stripe"), { company: "Stripe", role: null });
  eq(applyAsk("hey, apply me to Stripe"), { company: "Stripe", role: null });
  eq(applyAsk("please apply to the data analyst role at Ramp"), { company: "Ramp", role: "data analyst" });
  eq(applyManyAsk("ok apply to all of them")?.kind, "all");
  ok(linkAsk("apply me to https://boards.greenhouse.io/acme/jobs/12345"));
});

Deno.test("fixed: email status is the send rail's, never a draft to 'status', the application inbox or the tracker", () => {
  // trunk: "email status" drafted an email to a person named "status"; "any update on my emails" read the application inbox.
  eq(parseNetworkingAsk("email status"), null);
  for (const m of ["email status", "any update on my emails", "hey where are my emails", "did my emails go out please", "what's the status of my outreach emails"]) {
    ok(emailStatusAsk(m), m);
    eq(pureRoute(m, world), "outreach_status", m);
  }
  ok(parseNetworkingAsk("email Maya at Stripe"), "a draft to a person still drafts");
});

Deno.test("fixed: application status in plain words; billing's bill; connectors with stray spaces and punctuation", () => {
  // trunk: the router (no deterministic turn).
  for (const m of ["what did I apply to", "status of my apps", "where are my apps", "what have I applied to", "show me what I applied to", "hey where are my applications"]) {
    eq(statusAsk(m), { company: null }, m);
    eq(standingAsk(m), { kind: "status", company: null }, m);
  }
  eq(statusAsk("where are my emails"), null);
  for (const m of ["what's my bill", "my bill"]) eq(billingAsk(m), { kind: "price" }, m);
  eq(billingAsk("Stripe receipt"), null, "an application receipt is not a billing one");
  eq(connectorAsk("  what  do  you  have  access  to  "), { kind: "whats_connected" });
  eq(outlookAsk("is my outlook connected."), "status");
});
