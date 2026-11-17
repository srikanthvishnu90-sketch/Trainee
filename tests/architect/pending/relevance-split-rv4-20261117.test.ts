// Gap #8 split, reviews rv4 and rv5 (2026-11-17; probes rv4-cd/probes/d_go.ts, rv5-cd/probes/d5.ts). Architect ruling (rv5): the
// relevance split reads ONLY structured skills (the skills listed on an entry, and a skills-section skill bound to that entry by
// its evidence) against the posting's parsed requirements; no skill is detected in an entry's free text; no structured skills,
// no split. parseJD is trunk's, unchanged.
//   CU-2d  "Go-to-Market", "go live", "R&D": an entry is Additional Experience unless its structured skills match
//   CU-2e  parseJD equals trunk: "writing Go to build" keeps Go; nothing in the split changes the posting's parse
//   CU-2f  free text never moves an entry into Relevant: Spring season, en dash Go–to–Market, R&D, "used Go to build"
//   CU-2g  structured skills decide: listed on the entry, or bound from the skills section by evidence; none, no split
//   deno test -A --no-check tests/architect/pending/relevance-split-rv4-20261117.test.ts
import assertNode from "node:assert/strict";
import { CareerTailor } from "../../../supabase/functions/_shared/router_core.career.js";
import { relevanceSplit, relevantTo } from "../../../supabase/functions/_shared/career_tailor.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const heads = (r: any) => r.sections.map((s: any) => `${s.heading}: ${s.lines.map((l: any) => l.factIds[0]).join(",")}`).join(" || ");
const split = (facts: any[], jd: string, extra: any[] = []) => {
  const resume = { sections: [{ heading: "Experience", lines: facts.map((f) => ({ type: "entry", text: f.text, factIds: [f.id] })) }] };
  const j = CareerTailor.parseJD(jd), profile = { facts: [...facts, ...extra] };
  return { j, rel: [...relevantTo(j, profile, facts.map((f) => f.id))].sort(), out: heads(relevanceSplit(resume, j, profile)) };
};
const FILLER = [
  { id: "cafe", kind: "experience", text: "Cafe Uno, Barista (2023): opened and closed the store." },
  { id: "tutor", kind: "experience", text: "Lakeshore Tutoring, Tutor (2022): tutored calculus." },
];
const skillsOf = (j: any) => [...(j.mustHaveSkills || []), ...(j.niceToHaveSkills || [])];

Deno.test("CU-2d Go-to-Market, go live and R&D are no Go or R: those entries are Additional Experience", () => {
  const g1 = split([
    { id: "gtm", kind: "experience", text: "Elmstead, Go-to-Market Intern (2026): ran go-to-market campaigns and partner outreach." },
    { id: "py", kind: "experience", text: "Pixelforge, Software Intern (2025): built backend services in Python.", skills: ["Python"] },
    ...FILLER,
  ], "Backend Engineer Intern at Initech\n\nRequirements: Go, Python, PostgreSQL.");
  eq(g1.j.mustHaveSkills.includes("Go"), true, "the posting does ask for Go");
  eq(g1.rel, ["py"], "Go-to-Market is not Go");
  eq(g1.out, "Relevant Experience: py || Additional Experience: gtm,cafe,tutor");
  const g2 = split([
    { id: "sales", kind: "experience", text: "Northwind, Sales Associate (2026): helped customers go live and tracked deals." },
    { id: "rd", kind: "experience", text: "Acme, R&D Assistant (2025): ran lab experiments." },
    { id: "swe", kind: "experience", text: "Pixelforge, Software Intern (2024): wrote services in Go and R.", skills: ["Go", "R"] },
    { id: "cafe", kind: "experience", text: "Cafe Uno, Barista (2023)." },
  ], "Data Engineer Intern at Initech\n\nRequirements: Go, R, SQL.");
  eq(g2.rel, ["swe"], "go live is not Go, R&D is not R");
  eq(g2.out, "Relevant Experience: swe || Additional Experience: sales,rd,cafe");
});

Deno.test("CU-2e parseJD is trunk's: 'writing Go to build' keeps Go (d5.ts J1)", () => {
  const j = CareerTailor.parseJD("Backend Engineer Intern at Initech\n\nRequirements:\n- Experience writing Go to build backend services.\n- PostgreSQL.");
  eq(skillsOf(j).includes("Go"), true, JSON.stringify(skillsOf(j)));
  eq("skillsInContext" in CareerTailor, false, "no second skill reader beside trunk's");
});

Deno.test("CU-2f free text never moves an entry into Relevant Experience (d5.ts S1, S2, G3, G4; R&D)", () => {
  const cases: [string, any, string][] = [
    ["S1 Spring season vs a Java posting", { id: "x", kind: "experience", text: "Northwind, Business Development Intern (Spring 2025): booked meetings and kept the CRM current." }, "Backend Engineer Intern at Initech\n\nRequirements: Java, PostgreSQL."],
    ["S2 Spring season at a software company", { id: "x", kind: "experience", text: "Brightloop Software, Marketing Intern, Spring 2025: wrote newsletters and ran social posts." }, "Backend Engineer Intern at Initech\n\nRequirements: Java, Spring, SQL."],
    ["G3 'used Go to build' in free text", { id: "x", kind: "experience", text: "Pixelforge, Backend Intern (2025): used Go to build the payments backend." }, "Backend Engineer Intern at Initech\n\nRequirements: Go, PostgreSQL."],
    ["G4 en dash Go–to–Market", { id: "x", kind: "experience", text: "Elmstead Software, Go–to–Market Intern (2026): ran go–to–market campaigns." }, "Backend Engineer Intern at Initech\n\nRequirements: Go, Python, PostgreSQL."],
    ["R&D", { id: "x", kind: "experience", text: "Acme, R&D Assistant (2025): ran lab experiments in R&D." }, "Data Engineer Intern at Initech\n\nRequirements: R, SQL."],
  ];
  for (const [label, entry, jd] of cases) {
    const facts = [entry, { id: "py", kind: "experience", text: "Pixelforge, Software Intern (2024): built backend services in Python.", skills: ["Python"] }, ...FILLER];
    const r = split(facts, jd);
    eq(r.rel.includes("x"), false, `${label}: ${r.out}`);
  }
});

Deno.test("CU-2g structured skills decide: listed on the entry or bound from the skills section by evidence; none, no split", () => {
  const go = { id: "go", kind: "experience", text: "Pixelforge, Backend Intern (2025): built the payments backend." };
  const mkt = { id: "mkt", kind: "experience", text: "Brightloop, Marketing Intern (2024): wrote newsletters." };
  const jd = "Backend Engineer Intern at Initech\n\nRequirements: Go, PostgreSQL.";
  eq(split([go, mkt, ...FILLER], jd).out, "Experience: go,mkt,cafe,tutor", "no structured skills: one section");
  eq(split([{ ...go, skills: ["Go"] }, mkt, ...FILLER], jd).out, "Relevant Experience: go || Additional Experience: mkt,cafe,tutor", "listed on the entry");
  const bound = { id: "s1", kind: "skill", name: "Go", text: "Skill: Go", skills: ["Go"], evidence: ["go"] };
  eq(split([go, mkt, ...FILLER], jd, [bound]).out, "Relevant Experience: go || Additional Experience: mkt,cafe,tutor", "a skills-section skill bound by evidence");
  const unbound = { ...bound, evidence: [] };
  eq(split([go, mkt, ...FILLER], jd, [unbound]).out, "Experience: go,mkt,cafe,tutor", "a skills-section skill bound to no entry moves nothing");
});
