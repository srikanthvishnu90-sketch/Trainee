// ADVICE DEPTH (2026-10-30): the 340-seed deterministic grader must stay clean, and the open-question router must catch the phrasings
// "what does it take to become X", "is X worth it", "should I major in X" while leaving company-specific asks to code.
//   deno test -A --no-check tests/architect/advice-wide.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { CTXS, gradeSeed, OCCS, summarize, wideSeeds } from "../../evals/career/advice-wide.ts";

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const ctx = () => host.createTurnCtx({ userId: "u-w", threadId: "t-w", now: Date.UTC(2026, 9, 30, 15), snapshot: null, accountPersistence: true });
const ON = { get: (k: string) => ({ CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on" } as Record<string, string>)[k] };
const decide = (m: string) => stagedDecision({ env: ON, message: m, ctx: ctx(), host, structured: false });

Deno.test("AW-1 340 seeds across fields, ages and stages: every seed clean on route, field, stage, overlay, paragraph and brief", async () => {
  const seeds = wideSeeds();
  assertNode.ok(seeds.length >= 300);
  const groups = new Set(seeds.map((s) => s.group));
  for (const g of ["high school", "grad", "40+", "military to civilian", "career changer", "new grad", "student", "laid off"]) assertNode.ok(groups.has(g), g);
  assertNode.ok(OCCS.length >= 40 && CTXS.length >= 20);
  const rows = []; for (const s of seeds) rows.push(await gradeSeed(s));
  const sum = summarize(rows);
  assertNode.deepStrictEqual(sum.causes, [], JSON.stringify(sum.causes));
});

Deno.test("AW-2 open phrasings the old regex missed go to the brain", () => {
  for (const m of ["what does it take to become a nurse?", "is nursing worth it?", "should I major in computer science?", "what's the path to becoming an electrician?",
    "how long does it take to become a lawyer?", "do I need a degree to be a paralegal?", "is it too late for me to become a teacher? I'm 45", "where do I even start if I want to be a pilot?",
    "I'm a junior in high school. Is engineering a good career?", "should I go into accounting?"]) {
    const d = decide(m); assertNode.ok(d.brain && ["open_career_question", "question"].includes(d.reason), `${m}: ${d.reason}/${d.intent}`);
  }
});

Deno.test("AW-3 company asks stay with code: the router claims them and the decision is the code route, not the brain", () => {
  for (const m of ["is Stripe worth it?", "should I go into the interview at Goldman Sachs?", "what does it take to get hired at Goldman Sachs as an analyst?", "is Goldman a good bet?",
    "How do I get hired at Acmeworks?", "how do I get a job at Acmeworks as a nurse", "apply to the Backend Software Engineer role at Ironstack Payments", "find me nurse jobs in Chicago", "watch data analyst roles in Austin"]) {
    const d = decide(m); assertNode.equal(d.brain, false, `${m}: ${d.reason}/${d.intent}`);
    assertNode.ok(["code_product", "action", "router_claimed", "kept_on_router", "host_control"].includes(d.reason), `${m}: ${d.reason}`);
  }
  // brands the router does not claim never become an OPEN question (known employers, or a name after at/for/with/from)
  for (const m of ["what does it take to be a Googler?", "how do I be a Googler?", "should I become a Meta engineer?", "is Ironstack Payments a good career move?", "How do I become a designer for Stripe?"]) assertNode.notEqual(decide(m).reason, "open_career_question", m);
});

import { FIELDS, genericField, OVERLAYS } from "../../supabase/functions/_shared/agent/research/fields.ts";
import { SHORTS, shortFor, template } from "../../supabase/functions/_shared/agent/research/shorts.ts";
import { unsupported } from "../../supabase/functions/_shared/agent/research/guard.ts";

Deno.test("AW-4 hand-written shorts: the 15 high-traffic fields exist, carry no figure or name, and differ from each other", () => {
  const keys = new Set(SHORTS.map((s) => s.key));
  for (const k of ["nursing", "law", "accounting", "ux", "product", "pilot", "welding", "swe", "datasci", "teaching", "electrician", "medicine", "marketing", "consulting", "ib"]) assertNode.ok(keys.has(k), k);
  const lines = SHORTS.flatMap((s) => [s.now, s.later, s.act, s.degree, s.worth]);
  for (const l of lines) assertNode.ok(!/\d/.test(l), `digit in: ${l}`);
  assertNode.equal(new Set(lines).size, lines.length, "no two hand-written lines are identical");
  for (const l of [...lines, ...FIELDS.flatMap((f) => f.short ? [f.short.now, f.short.later, f.short.act] : []), ...OVERLAYS.map((o) => o.lead ?? "")]) assertNode.deepStrictEqual(unsupported(l, "", true).filter((x) => !/^(?:ux|hvac|rn)$/i.test(x)), [], l);
});
Deno.test("AW-5 the template names the occupation and gives a route line, licensed or open", () => {
  for (const [n, local] of [["dental hygiene", true], ["wildlife biology", false], ["music", false], ["law enforcement", true]] as const) {
    const t = template(n, local); assertNode.ok([t.now, t.later, t.act, t.degree, t.worth].every((x) => x.includes(n)), n);
  }
  assertNode.notEqual(template("a", true).now, template("a", false).now);
});

Deno.test("AW-6 place names are not companies: state, city, country and branch names keep the question open", () => {
  for (const m of ["How do I become a nurse in Texas?", "How do I get hired as an electrician in California?", "What does it take to become a lawyer in New York?", "Is nursing worth it in Chicago?",
    "I'm a veteran leaving the Army. How do I become a paralegal?", "I'm a parent returning to work after six years at home. What's the path to becoming an investment banker?",
    "Should I become a nurse in Ontario?", "How do I become an electrician in Fresno?", "How do I become a nurse in Wichita Falls?", "How do I become a pharmacist in Puerto Rico?", "How do I become a nurse at Ohio State?", "How do I become a teacher at the University of Texas?", "What does it take to become a welder in Tulsa?", "How do I get hired as an electrician after the Navy?", "How do I become a teacher in San Francisco?", "Is plumbing worth it in Ohio?"]) {
    const d = decide(m); assertNode.ok(d.brain, `${m}: ${d.reason}/${d.intent}`);
  }
});

import { researchCareerQuestion } from "../../supabase/functions/_shared/agent/research/index.ts";
import { fallbackVerdict } from "../../supabase/functions/_shared/agent/research/reply.ts";
Deno.test("AW-7 'too late / too old' asks get a direct line about time to the credential, no invented figure, no 'too late' framing", async () => {
  const none = async () => ({ status: "ok" as const, facts: [], urls: [], cost_usd: 0 });
  for (const [label, local, q] of [["psychology", true, "I'm 47. Is it too late to become a psychologist?"], ["music", false, "Am I too old to become a musician?"], ["welding", false, "At my age, is it too late to become a welder?"]] as const) {
    const r = await researchCareerQuestion({ message: q, profile: { facts: [] }, deps: { search: none, publish: async () => ({ url: "https://f.example/p.md" }), derive: async () => ({ label, local }) }, now: Date.UTC(2026, 9, 30) });
    assertNode.equal(r.status, "ok"); if (r.status !== "ok") continue;
    assertNode.ok(/time to the credential, not age/.test(r.answer ?? ""), `${q}: ${r.answer}`);
    assertNode.ok(/\*\*Your question\.\*\* The question for/.test(r.brief_markdown), "brief answers it");
    const chat = fallbackVerdict(r);
    assertNode.ok(/^Realistically, the question for/.test(chat) && !/\btoo late\b/i.test(chat) && !/\d/.test(chat.replace(/https?:\S+/, "")), chat);
  }
});

Deno.test("AW-8 no unsourced market claim in any short line (catalog shorts, hand-written shorts, templates, late lines); templates do not repeat 'this week'", async () => {
  const MARKET = /\bdemand\b|steady|steadier|climbs|improves|exit options|opens many|crowded|scarce|competitive|costly|selective|take few|few applicants|reachable|hire interns|in demand|well paid|job security|rarely won|small slice|small share|small next to|lean on|hire\b[^.]*\binto\b|\bhires? on\b|are hired|go to a small|recruited far ahead|more competitive/i;
  const ADVICE = /check|depends on|cannot quote|\bask\b|raises your chances|within your control|you control/i;
  const claim = (l: string) => MARKET.test(l) && !ADVICE.test(l);
  const lines: [string, string][] = [];
  for (const f of [...FIELDS, genericField("x")]) for (const k of ["odds", "now", "later"] as const) lines.push([`fields:${f.id}.${k}`, f[k]]);
  for (const f of FIELDS) if (f.short) lines.push(...Object.entries(f.short).map(([k, v]) => [`fields:${f.id}.${k}`, v] as [string, string]));
  for (const s of SHORTS) for (const k of ["now", "later", "act", "degree", "worth"] as const) lines.push([`shorts:${s.key}.${k}`, s[k]]);
  for (const [n, local] of [["journalism", false], ["photography", false], ["wind energy", false], ["law enforcement", true], ["dental hygiene", true], ["sales", false], ["trucking", true], ["x", false], ["x", true], ["music", false]] as const) {
    const t = template(n, local);
    for (const k of ["now", "later", "act", "degree", "worth", "late"] as const) { lines.push([`template:${n}.${k}`, t[k]]); assertNode.ok(!/this week/i.test(t[k]), `repeats this week: ${t[k]}`); }
    assertNode.ok(t.now.split(/\s+/).length >= 18, `${n}: now line too thin`);
  }
  for (const k of ["nursing", "law", "accounting", "ux", "product", "pilot", "welding", "electrician", "plumbing", "hvac", "mecheng", "civileng", "swe", "datasci", "teaching", "medicine", "marketing", "consulting", "ib"]) {
    const sh = shortFor({ ...FIELDS[0], id: "other" as any, label: SHORTS.find((e) => e.key === k)!.name, short: undefined }, ""); lines.push([`late:${k}`, sh.late]);
  }
  const hits = lines.filter(([, l]) => claim(l)).map(([k, l]) => `${k}: ${l}`);
  assertNode.deepStrictEqual(hits, []);
  assertNode.notEqual(template("journalism", false).now, template("wind energy", false).now, "creative and field-science routes differ");
});
