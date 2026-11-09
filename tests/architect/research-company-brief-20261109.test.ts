// deno-lint-ignore-file no-explicit-any require-await
// R10 WO-H fix 14 (owner order 2026-11-09; spec APP-LAYER-15-FIXES B.5, B.6 continuation 5, C.22, E.5 items 42-49): company research
// before an interview. Replays the spec's user turns through the agent brain (agentTurn) with a scripted model ($0) over a synthetic
// web (tests/helpers/research_company_web.ts). The scripted draft is deliberately bad in places (volume called revenue, a forecast
// stated as a result, an undated development, an invented team initiative, a competitor its quote does not name, an unknown with an
// invented figure): code must drop each one. Every test here fails on trunk (no research_company tool, no company brief variant).
import assertNode from "node:assert/strict";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { companyInterviewAsk, researchAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { dayOnPage, enforceCompanyReply, meaningKept, pageLimit, parseDay, researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import type { MarketDeps } from "../../supabase/functions/_shared/agent/research/market.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { NOW, U, world } from "../helpers/research_company_web.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// The spec's turns, exactly (B.5 and B.6 continuation 5).
const T1 = "Research Stripe before my interview. I want the company, business model, recent developments and what I should ask.";
const T2 = "Data analyst internship.";
const T3 = "Less generic, what should I ask the hiring manager?";
const C5 = "I have a Stripe analyst interview. Tell me what I should know, not a generic company overview.";

// The scripted brain: one research_company call (the input a competent model gives for that turn), then its reply text.
async function turn(message: string, history: any[], deps: MarketDeps, input: Record<string, unknown>, reply: string) {
  let step = 0;
  const model = async () => (++step === 1 ? { content: [{ type: "tool_use", id: `m${history.length}`, name: "research_company", input }], stop_reason: "tool_use" } : { content: [{ type: "text", text: reply }], stop_reason: "end_turn" });
  const t: any = await agentTurn({ message, history, stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: deps } as any);
  return { t, call: t.tool_calls.find((c: any) => c.name === "research_company") };
}
const render = (d: any) => {
  const v: any = validateKind("research_brief", d, { now: NOW });
  ok(v.ok, JSON.stringify(v));
  const rec = { id: "f", userId: "u1", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as any;
  return { data: v.data, html: bodyHtml(rec, "fs1." + "a".repeat(64)), text: textOf(rec, { now: NOW }) };
};

Deno.test("WO-H/1 turn 1, role unknown: the brief overview is made meanwhile and the reply asks ONLY for the role", async () => {
  const w = world();
  const { t, call } = await turn(T1, [], w.deps, { company: "Stripe", question: T1, sites: ["stripe.example"] },
    "I started the Stripe overview and put it in the file https://evil.example/x. What role are you interviewing for? And when is the interview?");
  eq([call.ok, call.effect], [true, "write_own"], "a published File is a write to the person's own account");
  eq(w.published.length, 1, "the overview is made while the role is unknown");
  const d = w.published[0];
  eq([d.role, d.role_asked, d.role_asks.length], [undefined, true, 0], "no role is guessed and no role section is made");
  ok(d.unknowns.some((u: string) => /Which role you are interviewing for/.test(u)));
  eq((t.reply.match(/\?/g) ?? []).length, 1, t.reply);
  ok(/role/i.test(t.reply) && !/when is the interview/i.test(t.reply) && !/evil\.example/.test(t.reply), t.reply);
});

Deno.test("WO-H/2 the brief: facts, reading and unknowns separate; dated developments keep their meaning; defects are dropped", async () => {
  const w = world();
  const r: any = await researchCompany({ company: "Stripe", role: "Data analyst internship", question: T1, plan: { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] }, deps: w.deps, now: NOW });
  eq(r.status, "ok");
  // E.49: volume is not revenue; a forecast is not a result. E.43: recent items have dates that their page carries.
  eq(r.developments.map((x: any) => [x.date, x.measure, x.text]), [
    ["Feb 24, 2026", "volume", "Businesses on Stripe generated $1.9 trillion in total volume in 2025, up 34% from 2024."],
    ["Feb 2026", "forecast", "The Revenue suite is on track to reach a $1 billion annual run rate in 2026."],
  ]);
  // E.48: no invented team initiative; competitors backed by a quote that names them.
  eq(r.competitors.map((x: any) => x.name), ["Adyen"]);
  eq(r.questions.map((q: any) => q.text), ["Your team is working on blocking fraudulent payments with Radar. How do you decide between blocking more payments to reduce fraud losses and letting good payments through?"]);
  eq(r.unknowns, ["Which team the role sits on and how it is measured."], "an unknown with an invented figure is dropped");
  eq(r.role_asks.length, 2);
  ok(r.frame && r.frame.cite.length === 2, "the reading names its sources");
  eq(r.dropped, 6, "revenue-for-volume, forecast-as-result, undated, Square, crypto initiative, invented 3%");
  // E.47: paywalled and outdated sources are marked; an unopened source is named with why.
  const by = Object.fromEntries(r.sources.map((s: any) => [s.url, s]));
  eq([by[U.paywall].limit, by[U.update].by, by[U.rivals].by], ["paywalled", "company", "reported"]);
  ok(r.unread.some((u: string) => /^refuses\.example: not read, because it answered with an error/.test(u)), JSON.stringify(r.unread));
  eq([by[U.old].limit, by[U.old].dated], ["outdated", "Mar 3, 2023"], "a page whose newest date is over 18 months old is marked outdated");
  ok(!r.sources.some((s: any) => s.url === U.refused), "a page that could not be opened is never a source");
  // E.46: a list of links without synthesis is not the brief; every section holds guarded lines and the File renders in order.
  const { html, text } = render(w.published[0]);
  const heads = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  eq(heads, ["What the company sells and how it makes money", "Recent developments", "Competitors and tradeoffs", "What the role page asks for", "Questions you can ask", "What this brief cannot tell you", "Sources"]);
  ok(html.includes('<span class="src rb-measure">Volume, not revenue</span>') && html.includes("A forecast at the time, not a result"));
  ok(/Stripe signed more enterprise customers this year\.[^]*?<span class="src rb-limit">\[\d+\] paywalled<\/span>/.test(html), "the paywall mark sits beside the claim it affects");
  ok(html.includes("Trainee&#39;s reading") || html.includes("Trainee's reading"), "the frame is labelled as Trainee's reading");
  ok(html.includes("Research only: nothing was sent or applied for"));
  ok(!/<script|javascript:/i.test(html));
  ok(text.includes("## Recent developments") && text.includes("Feb 24, 2026: Businesses on Stripe generated $1.9 trillion") && text.includes("(Volume, not revenue)"));
  ok(/usage-based billing for software companies\.[^]*?<span class="src rb-limit">\[\d+\] outdated · Mar 3, 2023<\/span>/.test(html), "the outdated mark sits beside its claim");
  ok(text.includes("paywalled") && text.includes("outdated, Mar 3, 2023"), "the text twin carries the limits too");
});

Deno.test("WO-H/3 turns 2 and 3: the role is used without asking again; 'less generic' expands the questions only", async () => {
  const w = world();
  const h1 = [{ role: "user", content: T1 }, { role: "assistant", content: "I started the Stripe overview; it's in the file. What role are you interviewing for?" }];
  const two = await turn(T2, h1, w.deps, { company: "Stripe", role: "Data analyst internship", question: T2, sites: ["stripe.example"] },
    "The brief now covers the internship: metrics, dashboards and experiments, plus questions grounded in Radar's fraud tradeoff. It's in the file.");
  const d2 = w.published.at(-1);
  eq([d2.role, d2.role_asked, d2.role_asks.length > 0], ["Data analyst internship", undefined, true]);
  ok(!/\?/.test(two.t.reply), "no repeated question once the role is known");
  const h2 = [...h1, { role: "user", content: T2 }, { role: "assistant", content: two.t.reply }];
  const three = await turn(T3, h2, w.deps, { company: "Stripe", role: "Data analyst internship", question: T3, focus: "questions", audience: "hiring manager", sites: ["stripe.example"] },
    "Two questions for the hiring manager are in the file. Your team is working on blocking fraudulent payments with Radar. How do you decide between reducing fraud losses and declining legitimate customers? Also remember Stripe processed $1.9 trillion in 2025.");
  ok(/Fill ONLY that key[^]*hiring manager/.test(w.drafts.at(-1)!), "the model is asked for that area only");
  const d3 = w.published.at(-1);
  eq([d3.focus, d3.audience, d3.business.length, d3.developments.length, d3.competitors.length, d3.unknowns.length, d3.questions.length], ["questions", "hiring manager", 0, 0, 0, 0, 2]);
  ok(d3.questions.every((q: any) => /^Your team is working on .+\. How do you decide between .+ and .+\?$/.test(q.text)));
  ok(!/1\.9 trillion/.test(three.t.reply), "a figure outside the expanded area is removed from the reply");
  ok(/hiring manager/.test(three.t.reply));
  const { html } = render(d3);
  eq([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ["Questions you can ask", "Sources"]);
});

Deno.test("WO-H/4 routing: the spec's interview research asks reach the research path; prep without a company does not", () => {
  for (const m of [T1, C5, "I've got a Ramp product interview, what should I ask?"]) ok(researchAsk(m), m);
  ok(companyInterviewAsk(C5));
  for (const m of ["what should I ask in my interview?", "I have an interview tomorrow", "I have a final round interview, what should I wear?"]) ok(!companyInterviewAsk(m), m);
});

Deno.test("WO-H/5 guards on their own: dates, metric meaning, source limits, reply enforcement", () => {
  eq(parseDay("Feb 24, 2026"), { y: 2026, m: 2, d: 24 }); eq(parseDay("2026-02"), { y: 2026, m: 2, d: null }); eq(parseDay("someday"), null);
  ok(dayOnPage(parseDay("2026-02-24")!, "Published February 24, 2026.") && !dayOnPage(parseDay("2026-02-25")!, "Published February 24, 2026."));
  eq(meaningKept("Stripe's revenue was $1.9 trillion", "Businesses on Stripe generated $1.9 trillion in total volume").ok, false);
  eq(meaningKept("The suite reached $1 billion", "The suite is on track to reach $1 billion").ok, false);
  eq(meaningKept("The Revenue suite is on track for $1 billion", "The Revenue suite is on track to reach $1 billion").measure, "forecast");
  eq(pageLimit("Stripe news. Subscribe to continue reading.", NOW).limit, "paywalled");
  eq(pageLimit("Posted March 3, 2023.", NOW), { limit: "outdated", dated: "Mar 3, 2023" });
  eq(pageLimit("Posted October 2, 2026.", NOW), {});
  const r: any = { kind: "company", status: "ok", company: "Stripe", role: null, ask: "role", focus: "all", audience: null, frame: null, business: [{ text: "Stripe Billing handles subscriptions.", cite: [1] }], developments: [], competitors: [], role_asks: [], questions: [], unknowns: [], sources: [], unread: [] };
  eq(enforceCompanyReply("Stripe grew 80% last year. Billing handles subscriptions. Which role is it for? What date is the interview?", r), "Billing handles subscriptions. Which role is it for?");
});
