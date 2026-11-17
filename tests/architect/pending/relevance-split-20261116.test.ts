// The 10/10 rubric's gap #8, tailoring half (2026-11-16; live-12 C10). Architect ruling: entries are never reordered inside a
// section (RESUME-TEMPLATES E5); a resume tailored to one posting splits Experience into Relevant then Additional Experience.
//   CU-2   the split, each section newest first; one section stays without the split, with fewer than four entries, or on an edit
//   CU-2b  structured skill overlap decides relevance; the changelog says the split only when the printed file shows it
//   CU-2c  (review rv3) no kind-of-work words: no skills on either side, no split; never "same as your base resume" with a split
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/relevance-split-20261116.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter, CareerTailor } from "../../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { edgeRenderer, memoryResumeStore, relevanceSplit, relevantTo, tailorForPosting } from "../../../supabase/functions/_shared/career_tailor.ts";
import { POSTINGS } from "../../../evals/mirror/instinct-wa-batch1/world.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const TURNS: { id: string; prompt: string }[] = Deno.readTextFileSync(new URL("prompts.jsonl", DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const PERSONA: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const NOW = Date.parse("2026-11-16T15:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
// Architect ruling (review rv5): the split reads STRUCTURED skills only (an entry's listed skills, or a skills-section skill bound
// to it), never skills found in its free text. Resume ingest gives no entry structured skills, so these fixtures state each
// entry's skills as structured data (bindSkills); every assertion below is unchanged.
const bindSkills = (profile: any, by: Record<string, string[]>) => { for (const f of profile.facts) { const k = Object.keys(by).find((x) => f.kind === "experience" && String(f.text).startsWith(x)); if (k) f.skills = by[k]; } return profile; };
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return bindSkills(ctx.profile, { "Pixelforge": ["React", "JavaScript"], "Crestline Partners": ["Python"] });
}

Deno.test("CU-2 C10: a tailored resume splits experience into Relevant then Additional Experience, each newest first", async () => {
  const p = POSTINGS[0];
  const tailor = { posting: async () => ({ job_id: p.id, title: p.title, company: p.company, description: p.description }), personas: { get: async () => ({ items: [], active: null }), put: async () => {} } as any, resumes: memoryResumeStore(), render: edgeRenderer(), deliver: () => {} };
  const results: string[] = [];
  const model = async (q: any) => {
    const last = q.messages.at(-1);
    if (Array.isArray(last?.content)) for (const b of last.content) if (b.type === "tool_result") results.push(String(b.content));
    return results.length ? text("Here is the review draft. Nothing was submitted.") : use("tailor_resume", { job_id: p.id });
  };
  const r: any = await agentTurn({ message: TURNS.find((x) => x.id === "C10")!.prompt, history: [], stores: { profile: personaProfile() }, userId: "00000000-0000-4000-8000-000000001611", threadId: "th", now: NOW, model, tailor } as any);
  eq(r.tool_calls.map((c: any) => [c.name, c.ok]), [["tailor_resume", true]], results[0]?.slice(0, 300));
  const out = JSON.parse(results[0]);
  const preview = String(out.preview ?? "");
  ok(/RELEVANT EXPERIENCE/i.test(preview) && !/^Elmstead/m.test(preview.slice(preview.search(/RELEVANT EXPERIENCE/i)).split("\n").slice(1, 2).join("")), `the tool's resume does not split, or a go-to-market role leads: ${preview.slice(0, 500)}`);
  ok(/Split your experience for this posting: \d+ under Relevant Experience/.test(String(out.changelog ?? "")), `the changelog says what moved: ${out.changelog}`);
  // The whole document: the two sections in place of Experience, every entry once, each section newest first (E5).
  const base = { userId: "00000000-0000-4000-8000-000000001612", profile: personaProfile(), posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true };
  const v: any = await tailorForPosting({ ...base, split: "relevance" } as any);
  ok(v.ok, JSON.stringify(v).slice(0, 300));
  const of = (sec: string) => v.detail.doc.lines.filter((l: any) => l.section === sec && l.type === "entry").map((l: any) => String(l.text).split(",")[0]);
  const rel = of("Relevant Experience"), add = of("Additional Experience");
  ok(rel.includes("Pixelforge") && rel.includes("Crestline Partners") && !rel.includes("Elmstead"), rel.join(" | "));
  ok(add.includes("Elmstead") && add.indexOf("Elmstead") < add.indexOf("Mindgrove AI Research"), add.join(" | "));
  ok(rel.indexOf("Crestline Partners") < rel.indexOf("Pixelforge"), `newest first inside Relevant Experience: ${rel.join(" | ")}`);
  eq(rel.length + add.length, 9, "every entry prints once");
  eq(of("Experience"), [], "no third section");
  // Without the split, the single newest-first section stays (D-071).
  const plain: any = await tailorForPosting(base as any);
  eq(plain.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0);
  const edited: any = await tailorForPosting({ ...base, split: "relevance", edits: [{ role: "pixelforge", lines: 1 }] } as any);
  eq(edited.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0, "an edited version keeps the order its edits set");
  const short = personaProfile();
  short.facts = short.facts.filter((f: any) => f.kind !== "experience" || /Pixelforge|Elmstead|Mindgrove/.test(String(f.text)));
  const few: any = await tailorForPosting({ ...base, profile: short, split: "relevance" } as any);
  eq(few.detail.doc.lines.filter((l: any) => l.section === "Relevant Experience").length, 0, "three entries stay in one section");
});

// Review of f7abd6c30: the relevance test is whole words (a "Product Manager" posting does not make "management software" relevant),
// a technical posting counts any programming stack an entry shows (not only title words), and the changelog says the split only
// when the printed file shows it (their own layout prints its own headings).
Deno.test("CU-2b the split reads whole words and stack; the changelog says it only when the printed file shows it", async () => {
  const facts = [
    { id: "e1", kind: "experience", text: "Northwind, Marketing Lead (2025 - present): campaigns and partner launches." },
    { id: "e2", kind: "experience", text: "Acme, Backend Engineer (2023-2024): built services in Go and Kubernetes.", skills: ["Go", "Kubernetes"] },
    { id: "e3", kind: "experience", text: "Bluebird, Co-founder (2022): youth-sports management software." },
    { id: "e4", kind: "experience", text: "Cafe Uno, Barista (2021)." },
  ];
  const profile = { facts };
  const resume = { sections: [{ heading: "Experience", lines: facts.map((f) => ({ type: "entry", text: f.text, factIds: [f.id] })) }] };
  const heads = (r: any, h: string) => (r.sections.find((x: any) => x.heading === h)?.lines ?? []).map((l: any) => l.factIds[0]);
  // Architect direction (rv3): structured overlap only, so a posting that names Go and Kubernetes makes the Go entry relevant,
  // and one that names only Java, Python and SQL makes nothing here relevant (no split).
  const swe = relevanceSplit(resume, CareerTailor.parseJD("Software Engineer Intern at Initech\n\nGo, Kubernetes, Docker."), profile);
  ok(heads(swe, "Relevant Experience").includes("e2"), `Go and Kubernetes named by the posting: ${JSON.stringify(swe.sections.map((x: any) => x.heading))}`);
  ok(heads(swe, "Additional Experience").includes("e1") && heads(swe, "Additional Experience").includes("e4"), JSON.stringify(heads(swe, "Additional Experience")));
  const java = relevanceSplit(resume, CareerTailor.parseJD("Software Engineer Intern at Initech\n\nJava, Python, SQL."), profile);
  eq(java.sections.map((x: any) => x.heading), ["Experience"], "no overlap, no split");
  const pm = relevanceSplit(resume, CareerTailor.parseJD("Product Manager Intern at Initech\n\nWork with engineering and design to define features."), profile);
  ok(!heads(pm, "Relevant Experience").includes("e3"), "'management' is not the word 'manager'");
  // Their own layout printed its own headings, without the split: the changelog does not say it was split.
  const p = POSTINGS[0];
  const real = edgeRenderer();
  const own = async (doc: any) => {
    const r: any = await real(doc);
    // Their own file prints its own single heading over the same entries.
    const lines = (doc.sections as any[]).flatMap((x) => [/Experience$/.test(x.heading) ? "Experience" : x.heading, ...x.lines.map((l: any) => l.text)]).filter((l, i, all) => !(l === "Experience" && all.indexOf("Experience") !== i));
    return r.ok ? { ...r, layout: "own", lines } : r;
  };
  const base = { userId: "00000000-0000-4000-8000-000000001613", profile: personaProfile(), posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company }, deps: { render: own, resumes: memoryResumeStore() }, now: NOW, reviewDraft: true, split: "relevance" };
  const v: any = await tailorForPosting({ ...base, layout: "own", ownDocx: new Uint8Array([80, 75]) } as any);
  ok(v.ok, JSON.stringify(v).slice(0, 300));
  ok(!/Split your experience/.test(String(v.changelog)), `the changelog claims a split the file does not show: ${v.changelog}`);
  // The plain render prints both headings, and there the changelog says it.
  const plain: any = await tailorForPosting({ ...base, deps: { render: real, resumes: memoryResumeStore() } } as any);
  ok(/Split your experience for this posting/.test(String(plain.changelog)), String(plain.changelog));
});

// Review rv3 of ag/cd-d-relevance-split (probes-rv3-cd/d3_probe.ts), architect direction: relevance is structured skill overlap
// only (the posting's own skills against each entry's named skills and tools, a framework counting for its language); no "kind of
// work" word lists (they made a product-marketing entry relevant to a software posting and "data entry" relevant to data roles).
// With no skills on either side there is no split. A split resume is never "the same as your base resume".
const RES = `Jordan Lee
Northfield University, BS Computer Science, Expected May 2028. GPA 3.7
Skills: Python, Java, SQL, Excel
Experience
Brightline, Product Marketing Intern (June 2026 - August 2026): launched the developer platform's API campaign; built landing pages and content for our app; grew signups 30%.
Corvid Labs, Software Engineering Intern (2025): built REST APIs in Java and Spring; deployed services to AWS.
Kestrel Analytics, Data Analyst Intern (2024): SQL dashboards in Tableau; weekly metrics for the sales team.
Northfield Library, Data Entry Assistant (2023): entered catalog data.
Maple Cafe, Barista (2022 - 2023): served customers; trained new staff.
Campus Research Lab, Research Assistant (2023): user research interviews and a literature review.`;
const profileFrom = (resume: string) => { const ctx: any = { now: NOW, thread: {} }; CareerRouter.handleChat(`Here's my resume:\n${resume}`, ctx); CareerRouter.handleChat("Yes, that's my resume", ctx); return bindSkills(ctx.profile, { "Corvid Labs": ["Java", "Spring", "AWS"], "Kestrel Analytics": ["SQL", "Tableau"] }); };

Deno.test("CU-2c structured skill overlap only: the one judgement for the split and the changelog; no skills, no split", async () => {
  const profile = profileFrom(RES);
  const make = (title: string, desc: string, prof = profile) => tailorForPosting({ userId: "00000000-0000-4000-8000-000000001614", profile: prof, posting: { text: `${title} at Acme\n\n${desc}`, job_id: "x", company: "Acme" }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true, split: "relevance" } as any);
  const heads = (v: any, sec: string) => v.detail.doc.lines.filter((l: any) => l.section === sec && l.type === "entry").map((l: any) => String(l.text).split(",")[0]);
  const swe: any = await make("Software Engineer Intern", "Build backend services in Java. Strong CS fundamentals.");
  eq(heads(swe, "Relevant Experience"), ["Corvid Labs"], "D1: the product-marketing entry is not relevant to a software posting");
  ok(heads(swe, "Additional Experience").includes("Brightline"));
  const mkt: any = await make("Marketing Analyst Intern", "Analyze campaign performance with SQL.");
  eq(heads(mkt, "Relevant Experience"), ["Kestrel Analytics"], "D9: SQL, never 'data entry'");
  ok(heads(mkt, "Additional Experience").includes("Northfield Library"));
  for (const [t, d] of [["Product Marketing Manager Intern", "Own launches and messaging for our developer platform."], ["Software Marketing Intern", "Write launch content for our software products."], ["Strategy and Operations Associate", "Drive cross-functional projects; build dashboards; analysis."]]) {
    const v: any = await make(t, d);
    eq(heads(v, "Relevant Experience"), [], `${t}: no skills named, no split`);
    ok(heads(v, "Experience").length === 6, `${t}: one Experience section`);
  }
  // The one judgement: an entry is under Relevant Experience exactly when relevantTo says so.
  const jd = CareerTailor.parseJD("Software Engineer Intern at Acme\n\nBuild backend services in Java. Strong CS fundamentals.");
  const entries = swe.detail.doc.lines.filter((l: any) => l.type === "entry" && /Experience$/.test(l.section));
  const judged = relevantTo(jd, profile, entries.map((l: any) => String(l.factIds[0])));
  for (const l of entries) eq(l.section === "Relevant Experience", judged.has(String(l.factIds[0])), String(l.text).slice(0, 40));
  ok(!/doesn't ask for/.test(String(swe.changelog)), String(swe.changelog));
  // A split resume is never "the same as your base resume" (D5 on the reviewed head said both).
  const lean = profileFrom(`Jordan Lee
Northfield University, BS Economics, Expected May 2028.
Skills: SQL, Excel
Experience
Kestrel Analytics, Data Analyst Intern (2025): SQL dashboards in Tableau.
Maple Cafe, Barista (2024): served customers.
Northfield Library, Assistant (2023): shelved books.
Campus Store, Cashier (2022): ran the register.`);
  for (const v of [swe, mkt, await make("Data Analyst Intern", "Analyze data with SQL.", lean), await make("Growth Engineer Intern", "Build experiments in our web app in TypeScript.")] as any[]) {
    ok(!(/Same as your base resume/.test(String(v.changelog)) && /Split your experience/.test(String(v.changelog))), String(v.changelog));
  }
});
