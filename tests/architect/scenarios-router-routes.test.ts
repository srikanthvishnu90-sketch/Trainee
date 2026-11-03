// ROUTER ROUTING ROUND (architect, 2026-11-02; D-007): 10,000 seeded messages over the router's routing decisions, pure code
// (no database, no model, no network). Job search vs people search vs company research vs pay questions vs application
// status vs outreach, said as questions, commands, in lower case, with typos, emoji and filler, two asks in one, in other
// languages, and at employers whose names are everyday words or carry "people", "team", "jobs" or "hired" (Applebee's,
// People Inc., Teamworks, Jobber, Hired, Status Labs, Applied Materials, Indeed). The generator
// (tests/architect/scenarios/router-routes-generator.ts) writes each case's truth from its template; the landing
// (tests/architect/scenarios/router-routes-landing.ts) is observed in the handler's order: the code-first turns, the staged
// brain's decision (CAREER_BRAIN=staged, CAREER_KNOWLEDGE=on), then the router and the handler's role search.
//
// On trunk d5668fc54 the battery failed 2,556 of 10,000: job 1,072, job questions 512, pay 722, other languages 188, outreach
// 33, status 14, people 7, Indeed 5, two asks 3. The misroutes are pinned below by name, at the code that was wrong.
//   deno test -A --no-check tests/architect/scenarios-router-routes.test.ts
import assertNode from "node:assert/strict";
import { ACTING, cases, FILED, SEED } from "./scenarios/router-routes-generator.ts";
import { land, STAGED } from "./scenarios/router-routes-landing.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { codeProduct, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { parseTargetAsk } from "../../supabase/functions/_shared/career_people_provider.ts";
import { targetAskOf } from "../../supabase/functions/_shared/career_people.ts";
import { parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-rr", threadId: "t-rr", now: Date.UTC(2026, 10, 2, 15), snapshot: null, accountPersistence: true });
const run = (m: string) => { const ctx = fresh(); const out = host.runTurn(m, ctx); return { out, r: (out.result ?? {}) as Record<string, any>, ctx }; };
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const decide = (m: string, e = STAGED) => stagedDecision({ env: e, message: m, ctx: fresh(), host, structured: false });

const all = cases();
console.error = () => {};

Deno.test("10,000 messages: each lands where its intent needs, nothing is sent, no acting turn takes one", () => {
  eq(all.length, 10_000, "the generator makes 10,000 distinct messages");
  eq(SEED, 20261102);
  const byFamily: Record<string, { n: number; strict: number; landings: Record<string, number> }> = {};
  const misroutes: string[] = [];
  const invented: string[] = [];
  for (const c of all) {
    const l = land(c.message);
    const f = (byFamily[c.family] ??= { n: 0, strict: 0, landings: {} });
    f.n++; if (c.strict) f.strict++;
    f.landings[l.landing] = (f.landings[l.landing] ?? 0) + 1;
    if (!(c.expect as string[]).includes(l.landing) || l.sends !== 0 || ACTING.includes(l.landing)) {
      misroutes.push(`${c.strict ? "strict" : "noisy"} ${c.family} [${c.variant}] ${JSON.stringify(c.message)}: expected ${c.expect.join("|")}, got ${l.landing}${l.intent ? ` (${l.intent}/${l.reason})` : ""}${l.sends ? ` sends=${l.sends}` : ""}`);
    }
    // D-007: a people plan is the firm the person typed, never a default set ("investment bankers" at the bulge bracket).
    if (l.landing === "people_plan" && c.company && (/You named no firms/.test(l.reply) || !l.reply.toLowerCase().includes(c.company.toLowerCase().replace(/\.$/, "")))) {
      invented.push(`${JSON.stringify(c.message)}: ${l.reply.slice(0, 160)}`);
    }
    // The no-file answer names the firm the person asked about, never another.
    if (l.landing === "company_absent" && c.company && !l.reply.toLowerCase().includes(c.company.toLowerCase().replace(/\.$/, ""))) {
      invented.push(`${JSON.stringify(c.message)}: ${l.reply.slice(0, 160)}`);
    }
  }
  console.log(JSON.stringify(byFamily, null, 1));
  eq(misroutes.slice(0, 40), [], `${misroutes.length} misroutes`);
  eq(invented.slice(0, 20), [], `${invented.length} plans or answers about a firm the person did not name`);
  for (const fam of ["job", "job_q", "people", "company", "pay", "status", "outreach", "multi", "foreign"]) ok(byFamily[fam]?.n >= 500, `${fam}: ${byFamily[fam]?.n}`);
});

// ------------------------------------------------------------------------------------------------ the misroutes, by name
Deno.test("fixed: 'X roles / openings / positions at Y' is the role search, never a people search for the title 'X role'", () => {
  // trunk: { kind: "role_at", titles: ["data analyst role"], company: "Applebee's" } (the people search, PR #417's find).
  for (const m of ["find me data analyst roles at Applebee's", "data analyst openings at Jobber", "search for nurse positions at Teamworks", "list accountant positions at People Inc.",
    "get me ux designer postings at Target", "look for product manager internships at Stripe", "find me openings at Hired", "find me line cook rles at Figma", "nurse oepnings at Gap"]) {
    eq(parseTargetAsk(m), null, m);
    eq(targetAskOf(m), null, m);
  }
  for (const m of ["find me data analyst roles at Applebee's", "data analyst roles at Jobber", "any nurse openings at Teamworks?", "got any accountant roles at People Inc.?", "are there ux designer roles at Hired?",
    "does Target have any accountant jobs?", "what nurse jobs does Stripe have?", "search Stripe jobs", "is Jobber hiring right now?", "is Applied Materials hiring data analysts?", "data analyst jobs at Status Labs"]) {
    eq(run(m).out.intent, "career_discovery", m);
  }
  eq(run("look for data analyst internships at Teamworks").out.intent, "career_internship_discovery");
  // Still people searches, and still not searches.
  for (const m of ["find recruiters at Applebee's", "data analysts at Jobber", "find engineers at People Inc.", "who are the hiring managers at Teamworks"]) eq(parseTargetAsk(m)?.kind, "role_at", m);
  for (const m of ["I got the job at Stripe", "the analyst role at Ramp", "apply to the data analyst role at Jobber", "what's the pay for data analyst roles at Jobber?", "tell me about data analyst roles at Stripe",
    "cancel the data analyst job at Jobber", "watch data analyst roles at Stripe", "who works at Jobber"]) {
    ok(!["career_discovery", "career_internship_discovery"].includes(run(m).out.intent), `${m}: ${run(m).out.intent}`);
  }
});

Deno.test("fixed: 'who works at People Inc.' / 'find people who work at X' is everyone at the firm, never the title 'who work'", () => {
  // trunk: titles ["who work"] (matching no one), or the router's campaign plan for "find people who work at X".
  for (const [m, co] of [["who works at People Inc.", "People Inc"], ["find people who work at Stripe", "Stripe"], ["employees at Jobber", "Jobber"], ["people working at Teamworks", "Teamworks"]]) {
    eq(parseTargetAsk(m), { kind: "role_at", titles: [], seniority: [], company: co }, m);
  }
  eq(parseTargetAsk("who works at my school"), null);
  // The department frame keeps its titles.
  eq(parseTargetAsk("who works in marketing at Ramp")?.titles, ["marketing"]);
});

Deno.test("fixed: a pay question at a firm with no file reaches the brain; the no-file answer no longer stops it", () => {
  // trunk: company_intel / company_file_absent, reason code_product ("Applebee's has no company file yet"), PR #417's find.
  for (const m of ["what does Applebee's pay?", "how much does Jobber pay data analysts?", "what's the salary for a nurse at Teamworks?", "how much do line cooks make at People Inc.?",
    "what does a ux designer at People Inc. make?", "what's the pay like at Hired?", "salary at Target for a data analyst?", "what does Indeed pay?", "salarry at Shell for a nurse?"]) {
    const d = decide(m);
    eq([d.brain, d.intent, d.reason], [true, "company_intel", "question"], m);
    eq(run(m).r.payload?.topic, "pay", m);
  }
  // A firm with a file: the file's comp answer stays code's (sourced).
  for (const m of ["what does Stripe pay?", "how much does Google pay data analysts?", "what's the salary for a software engineer at Figma?"]) {
    eq([decide(m).brain, decide(m).reason], [false, "code_product"], m);
    ok(FILED.some((co) => m.includes(co)));
  }
  // Any other no-file question stays the router's honest answer (tests/architect/advice-wide.test.ts AW-3).
  for (const m of ["tell me about Applebee's", "what's the culture like at Jobber?", "How do I get hired at Acmeworks?"]) eq(decide(m).brain, false, m);
  // Router mode (the kill switch): the router answers every turn as before.
  eq(decide("what does Applebee's pay?", env({ CAREER_BRAIN: "router" })).brain, false);
  ok(/has no company file yet/.test(run("what does Applebee's pay?").r.reply));
  // codeProduct, directly.
  eq(codeProduct("company_intel", { company: "Jobber", payload: { kind: "company_file_absent", company: "Jobber", topic: "pay" } }), false);
  eq(codeProduct("company_intel", { company: "Jobber", payload: { kind: "company_file_absent", company: "Jobber" } }), true);
  eq(codeProduct("company_intel", { company: "Stripe", payload: { kind: "company_file", topic: "pay" } }), true);
});

Deno.test("fixed: 'the hiring manager at X' and 'tell me what they pay' are not a disclosure to the person's own manager", () => {
  // trunk: disclosure_clarify, "Who exactly would receive it — your direct manager, or someone else?"
  for (const m of ["quick q: draft a message to the hiring manager at Google", "find product manager jobs at Hired and tell me what they pay", "draft a note to the product manager at Teamworks"]) {
    ok(run(m).out.intent !== "disclosure_clarify", `${m}: ${run(m).out.intent}`);
  }
  for (const m of ["can you tell my boss im looking", "text my manager that I'm leaving", "email my supervisor that I'm interviewing"]) eq(run(m).out.intent, "disclosure_clarify", m);
});

Deno.test("fixed: a message in another language is never answered with an English company file", () => {
  // trunk: company_intel with the firm's file ("wo ist meine Bewerbung bei Google?" got the Google file).
  for (const m of ["¿cuánto paga Stripe?", "wo ist meine Bewerbung bei Google?", "qui travaille chez Notion ?", "quanto paga a Ramp?", "was zahlt Goldman Sachs?", "McKinsey kitna pay karta hai?", "¿quién trabaja en Stripe?"]) {
    ok(run(m).out.intent !== "company_intel", `${m}: ${run(m).out.intent}`);
    eq(decide(m).brain, true, m);
  }
  // English that names a firm with a French-looking word stays English.
  eq(run("what's the culture like at Chez Panisse?").out.intent, "company_intel");
  eq(run("what do you have on status labs?").r.company, "status labs", "the whole name, typed in lower case");
});

Deno.test("fixed: an outreach ask naming a firm the library does not know plans that firm, never investment bankers at the bulge bracket", () => {
  // trunk: "Building the list now: investment bankers ... You named no firms, so the plan proposes ... Goldman Sachs, Morgan
  // Stanley, JPMorgan ..." for an ask that named Monster (D-007).
  for (const [m, co] of [["quick q: draft an email to people at Monster", "Monster"], ["write a cold email to someone at people inc.", "People Inc."], ["find analysts at Monster", "Monster"],
    ["find poeple who work at Applied Materials", "Applied Materials"]]) {
    const { out, r } = run(m);
    ok(!/You named no firms|investment bankers|bulge bracket/i.test(r.reply), `${m}: ${r.reply}`);
    ok(r.reply.includes(co), `${m} names ${co}: ${r.reply}`);
    eq(Number(r.sends ?? 0), 0);
    ok(/outreach_/.test(out.intent), out.intent);
  }
  // A vague ask with no firm keeps the parser's proposal (124's contract), held for the person to re-point.
  ok(/You named no firms/.test(run("find me 40 bankers to email").r.reply));
});

Deno.test("fixed: an application status ask naming a firm is the status answer, never that firm's company file", () => {
  // trunk: company_absent for "the status of my People Inc. application" (the "." in "Inc." ended the match) and the Goldman
  // file for "where's my application to Goldman Sachs?" (the router had no "where's my application" shape).
  for (const m of ["what's the status of my People Inc. application", "where's my application to Goldman Sachs?", "where's my applicaation to Goldman Sachs?"]) {
    ok(run(m).out.intent !== "company_intel", `${m}: ${run(m).out.intent}`);
  }
});

Deno.test("fixed: a command to write to someone at a firm is never a company-file question, typed with a slip or after 'quick q:'", () => {
  for (const m of ["help me wrrite to a recruiter at McKinsey", "darft a message to the hiring manager at Google", "draft a messgae to the hiring manager at Notion"]) {
    ok(run(m).out.intent !== "company_intel", `${m}: ${run(m).out.intent}`);
  }
  // The networking turn reads its asks after "quick q:" too.
  eq(parseNetworkingAsk("quick q: who do I know at Notion")?.kind, "who");
  eq(targetAskOf("quick q: find recruiters at Jobber")?.kind, "role_at");
  // A question about writing stays a question ("what should I write to a recruiter at Stripe?").
  eq(run("what's the best way to email a recruiter at Stripe?").out.intent !== "career_discovery", true);
});

Deno.test("fixed: a search at a named employer lists that employer's roles only, by its whole name, or says there are none", () => {
  const P = (id: string, company: string, title: string) => ({ job_id: id, id, company, title, location: "Chicago, IL", jd_text: `${title} at ${company}. SQL, Python, dashboards.`, url: `https://example.com/${id}` });
  const postings = [P("rr1", "Apple", "Data Analyst, Siri Metrics"), P("rr2", "Applebee's", "Restaurant Data Analyst"), P("rr3", "Stripe", "Software Engineer"), P("rr4", "Jobber", "Marketing Coordinator")];
  const at = (m: string) => { const ctx = fresh(); (ctx as any).postings = postings; const out = host.runTurn(m, ctx); return { out, r: (out.result ?? {}) as Record<string, any> }; };
  const companies = (m: string) => (at(m).r.shortlist ?? []).map((x: any) => x.company);
  // trunk: "Applebee's has no company file yet" for the first two, "Which employer source ... should we check next?" for the third.
  eq(companies("any jobs at Applebee's?"), ["Applebee's"], "never Apple's role for Applebee's");
  eq(companies("any jobs at Apple?"), ["Apple"], "never Applebee's role for Apple");
  eq(companies("is Jobber hiring right now?"), ["Jobber"]);
  const none = at("find me openings at Teamworks");
  eq([none.out.intent, none.r.shortlist], ["career_discovery", []]);
  ok(/No open roles at Teamworks on my list right now/.test(none.r.reply) && !/Stripe|Apple|Jobber/.test(none.r.reply), none.r.reply);
  // No employer named: every role on the list, as before ("find me jobs", "find me jobs at a startup").
  eq(companies("find me jobs").length, 4);
  eq(companies("find me jobs at a startup").length, 4);
});
