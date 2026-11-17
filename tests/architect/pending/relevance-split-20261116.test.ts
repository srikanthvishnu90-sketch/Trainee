// The 10/10 rubric's gap #8, tailoring half (2026-11-16; live-12 C10). Architect ruling: entries are never reordered inside a
// section (RESUME-TEMPLATES E5); a resume tailored to one posting splits Experience into Relevant then Additional Experience.
//   CU-2   the split, each section newest first; one section stays without the split, with fewer than four entries, or on an edit
//   CU-2b  whole words and programming stack decide relevance; the changelog says the split only when the printed file shows it
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/relevance-split-20261116.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter, CareerTailor } from "../../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { edgeRenderer, memoryResumeStore, relevanceSplit, tailorForPosting } from "../../../supabase/functions/_shared/career_tailor.ts";
import { POSTINGS } from "../../../evals/mirror/instinct-wa-batch1/world.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const TURNS: { id: string; prompt: string }[] = Deno.readTextFileSync(new URL("prompts.jsonl", DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const PERSONA: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const NOW = Date.parse("2026-11-16T15:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
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
    { id: "e2", kind: "experience", text: "Acme, Backend Engineer (2023-2024): built services in Go and Kubernetes." },
    { id: "e3", kind: "experience", text: "Bluebird, Co-founder (2022): youth-sports management software." },
    { id: "e4", kind: "experience", text: "Cafe Uno, Barista (2021)." },
  ];
  const profile = { facts };
  const resume = { sections: [{ heading: "Experience", lines: facts.map((f) => ({ type: "entry", text: f.text, factIds: [f.id] })) }] };
  const heads = (r: any, h: string) => (r.sections.find((x: any) => x.heading === h)?.lines ?? []).map((l: any) => l.factIds[0]);
  const swe = relevanceSplit(resume, CareerTailor.parseJD("Software Engineer Intern at Initech\n\nJava, Python, SQL."), profile);
  ok(heads(swe, "Relevant Experience").includes("e2"), `Go and Kubernetes count for a Java and Python posting: ${JSON.stringify(swe.sections.map((x: any) => x.heading))}`);
  ok(heads(swe, "Additional Experience").includes("e1") && heads(swe, "Additional Experience").includes("e4"), JSON.stringify(heads(swe, "Additional Experience")));
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

