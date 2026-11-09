// ROUTER ROUTING ROUND (architect, 2026-11-02): where a text lands, observed without a database, a model or the network, in
// the handler's order (supabase/functions/agent-chat/handler-career.ts handleChat) for a person with nothing pending:
//   1. the code-first turns (tests/architect/routing-scenarios.ts pureRoute, the architect's mirror of the handler's gates);
//   2. the staged brain's decision (career_staged.ts stagedDecision, CAREER_BRAIN=staged with CAREER_KNOWLEDGE=on);
//   3. the router's own answer (career_host runTurn over router_core.career.js), and the handler's role search after it
//      (career_search_judge.ts askFor).
// The landing names what the person gets; the generator's cases say which landings their intent needs.
import * as core from "../../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../../supabase/functions/agent-chat/career_staged.ts";
import { askFor } from "../../../supabase/functions/_shared/career_search_judge.ts";
import { targetAskOf } from "../../../supabase/functions/_shared/career_people.ts";
import { pureRoute } from "../routing-scenarios.ts";

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-rr", threadId: "t-rr", now: Date.UTC(2026, 10, 2, 15), snapshot: null, accountPersistence: true });
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
export const STAGED = env({ CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on", CAREER_RESEARCH_REPLY: "off" });

const PRE: Record<string, string> = {
  standing: "status", status: "status", outreach: "outreach", outreach_status: "outreach", outreach_replies: "outreach",
  site_refused: "site_refused", apply_queue: "apply", apply_cancel: "cancel", billing: "billing",
};
const STATUS_INTENTS = /^(?:tracking_|career_track|application_status|career_application_status|career_standing|doorstep_status)/;

export interface Landed { landing: string; pre: string; intent: string | null; reason: string | null; sends: number; kind: string | null; reply: string }
export function land(message: string, e = STAGED): Landed {
  const pre = pureRoute(message, {});
  if (pre === "networking") {
    const t = targetAskOf(message);
    return { landing: t ? "people" : "networking", pre, intent: null, reason: null, sends: 0, kind: t?.kind ?? null, reply: "" };
  }
  if (pre !== "router") return { landing: PRE[pre] ?? pre, pre, intent: null, reason: null, sends: 0, kind: null, reply: "" };
  const d = stagedDecision({ env: e, message, ctx: fresh(), host, structured: false });
  if (d.brain) return { landing: "brain", pre, intent: d.intent, reason: d.reason, sends: 0, kind: null, reply: "" };
  const ctx = fresh();
  const out = host.runTurn(message, ctx) ?? {};
  const r = (out.result ?? {}) as Record<string, any>;
  const intent: string | null = out.intent ?? null;
  const kind = String(r.payload?.kind ?? r.artifact?.kind ?? "") || null;
  const sends = Number(r.sends ?? 0) || 0;
  const reply = String(r.reply ?? "");
  const base = { pre, intent, reason: d.reason, sends, kind, reply };
  if (askFor(message, { intent: intent ?? undefined, resultStatus: r.resultStatus }, (ctx as any).discovery)) return { landing: "search", ...base };
  if (intent === "career_discovery" || intent === "career_internship_discovery") return { landing: "search", ...base };
  if (intent === "company_intel") return { landing: kind === "company_file_absent" ? "company_absent" : r.company ? "company_file" : `company_lib`, ...base };
  // The router's own plan for a list of people at a firm ("Building the list now: people at Stripe"), for outreach that
  // waits for the person's approval of the plan and of each exact email: a people search or an outreach ask may land here.
  if (intent === "outreach_clarification" && kind === "campaign_plan") return { landing: "people_plan", ...base };
  if (intent && /^outreach_|^networking_/.test(intent)) return { landing: "outreach", ...base };
  if (intent && STATUS_INTENTS.test(intent)) return { landing: "status", ...base };
  // Who the person knows at a firm, from their own graph: the networking answer, read-only.
  if (intent === "graph_paths") return { landing: "networking", ...base };
  return { landing: `router:${intent ?? "none"}`, ...base };
}
